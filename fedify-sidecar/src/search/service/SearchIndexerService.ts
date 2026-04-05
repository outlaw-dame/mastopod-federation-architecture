/**
 * SearchIndexerService — Option 2: Dedicated Search Indexer Service
 *
 * Self-contained pipeline:
 *
 *   ap.firehose.v1  ──►  ApSearchProjector  ──►  SearchEventBus
 *   ap.tombstones.v1                                    │
 *                                                       ▼
 *                                            PublicContentIndexWriter
 *                                                       │
 *                                                       ▼
 *                                             OpenSearch  public-content-v1
 *
 * Ownership:
 *   - Manages its own Kafka consumer group (never shares with other features).
 *   - Uses an in-process SearchEventBus so search events never go back to
 *     Redpanda (no extra topic hop required).
 *   - Falls back to InMemorySearchDocAliasCache when no Redis client is provided
 *     (suitable for single-process deployments and tests).
 *
 * Backpressure:
 *   - When IndexWriter throws, the consumer is paused and the failed payload is
 *     re-queued internally.  Retry begins after BACKPRESSURE_RETRY_DELAY_MS.
 *
 * Topic names:
 *   Defaults match the V6 topology (ap.firehose.v1, ap.tombstones.v1).
 *   Override via REDPANDA_FIREHOSE_TOPIC / REDPANDA_TOMBSTONE_TOPIC env vars or
 *   the config object.
 */

import { Kafka, Consumer, EachBatchPayload, logLevel } from 'kafkajs';
import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import { logger } from '../../utils/logger.js';
import { ApSearchProjector } from '../projectors/ApSearchProjector.js';
import { PublicContentIndexWriter } from '../writer/PublicContentIndexWriter.js';
import { DefaultOpenSearchClient } from '../writer/OpenSearchClient.js';
import { DefaultSearchDedupService } from '../aliases/SearchDedupService.js';
import {
  InMemorySearchDocAliasCache,
  RedisSearchDocAliasCache,
  type SearchDocAliasCache,
} from '../writer/SearchDocAliasCache.js';
import { SearchEventBus } from './SearchEventBus.js';
import type { IdentityAliasResolver, ResolvedIdentity } from '../identity/IdentityAliasResolver.js';
import type { SearchPublicUpsertV1, SearchPublicDeleteV1 } from '../events/SearchEvents.js';

// ─── Config ─────────────────────────────────────────────────────────────────

export interface SearchIndexerServiceConfig {
  /** Redpanda/Kafka broker list */
  brokers: string[];
  /** KafkaJS clientId (should be unique per node) */
  clientId: string;
  /** Consumer group ID — do NOT share with opensearch-indexer legacy group */
  groupId: string;

  /** V6 firehose topic (default: ap.firehose.v1) */
  firehoseTopic: string;
  /** V6 tombstone topic (default: ap.tombstones.v1) */
  tombstoneTopic: string;

  /** OpenSearch node URL */
  opensearchUrl: string;
  /** Optional basic-auth username */
  opensearchUsername?: string;
  /** Optional basic-auth password */
  opensearchPassword?: string;
  /** Whether to reject self-signed TLS certs (default: true) */
  opensearchSslVerify: boolean;

  /** Redis client for alias cache (provide `null` to use in-memory fallback) */
  redis: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> } | null;

  /** How long to wait before retrying after an OpenSearch bulk failure (ms) */
  backpressureRetryDelayMs: number;
}

// ─── No-op identity resolver ────────────────────────────────────────────────
// Used by default when the full IdentityBindingRepository is not available
// (i.e. most search-indexer deployments that don't need canonical-ID resolution).

class PassThroughIdentityAliasResolver implements IdentityAliasResolver {
  async resolveByCanonicalId(canonicalId: string): Promise<ResolvedIdentity> {
    return { canonicalId };
  }
  async resolveByApUri(apUri: string): Promise<ResolvedIdentity> {
    return { apUri };
  }
  async resolveByAtDid(did: string): Promise<ResolvedIdentity> {
    return { atDid: did };
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SearchIndexerService {
  private readonly config: SearchIndexerServiceConfig;
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly bus: SearchEventBus;
  private readonly projector: ApSearchProjector;
  private readonly writer: PublicContentIndexWriter;
  private readonly osClient: DefaultOpenSearchClient;

  private isRunning = false;
  private backpressureActive = false;

  constructor(
    config: SearchIndexerServiceConfig,
    identityResolver?: IdentityAliasResolver,
  ) {
    this.config = config;

    // ── Kafka consumer ───────────────────────────────────────────────────
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      logLevel: logLevel.WARN,
    });
    this.consumer = this.kafka.consumer({ groupId: config.groupId });

    // ── OpenSearch ───────────────────────────────────────────────────────
    const osNative = new OpenSearchNativeClient(
      config.opensearchUsername
        ? {
            node: config.opensearchUrl,
            auth: {
              username: config.opensearchUsername,
              password: config.opensearchPassword ?? '',
            },
            ssl: { rejectUnauthorized: config.opensearchSslVerify },
          }
        : {
            node: config.opensearchUrl,
            ssl: { rejectUnauthorized: config.opensearchSslVerify },
          },
    );
    this.osClient = new DefaultOpenSearchClient(osNative);

    // ── Alias cache ──────────────────────────────────────────────────────
    const aliasCache: SearchDocAliasCache = config.redis
      ? new RedisSearchDocAliasCache(config.redis)
      : new InMemorySearchDocAliasCache();

    const dedupService = new DefaultSearchDedupService(aliasCache);

    // ── In-process event bus ──────────────────────────────────────────────
    this.bus = new SearchEventBus();
    this.writer = new PublicContentIndexWriter(this.osClient, aliasCache, dedupService);

    // Wire bus → writer
    this.bus.on('search.public.upsert.v1', async (payload) => {
      await this.writer.onUpsert(payload as SearchPublicUpsertV1);
    });
    this.bus.on('search.public.delete.v1', async (payload) => {
      await this.writer.onDelete(payload as SearchPublicDeleteV1);
    });

    // ── Projector ────────────────────────────────────────────────────────
    const resolver = identityResolver ?? new PassThroughIdentityAliasResolver();
    this.projector = new ApSearchProjector(resolver, this.bus);
  }

  /**
   * Initialize the OpenSearch index (idempotent — safe to call on every startup).
   */
  async initialize(): Promise<void> {
    await this.osClient.initializeIndex();
    logger.info('[SearchIndexerService] OpenSearch index initialized');
  }

  /**
   * Start consuming from Redpanda and indexing into OpenSearch.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [this.config.firehoseTopic, this.config.tombstoneTopic],
      fromBeginning: false,
    });

    await this.consumer.run({
      eachBatch: async (payload: EachBatchPayload) => {
        await this.processBatch(payload);
      },
    });

    logger.info('[SearchIndexerService] Started', {
      firehoseTopic: this.config.firehoseTopic,
      tombstoneTopic: this.config.tombstoneTopic,
      groupId: this.config.groupId,
    });
  }

  /**
   * Gracefully stop the consumer.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    await this.consumer.disconnect();
    logger.info('[SearchIndexerService] Stopped');
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, isRunning, isStale, pause } = payload;

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;

      // Backpressure: wait until OpenSearch recovers
      if (this.backpressureActive) {
        pause();
        return;
      }

      try {
        const raw = message.value?.toString();
        if (!raw) {
          resolveOffset(message.offset);
          continue;
        }

        const event = JSON.parse(raw) as Record<string, unknown>;

        if (batch.topic === this.config.tombstoneTopic) {
          await this.projector.onApTombstoneEvent(event);
        } else {
          // FEP-268d consent gate: explicit opt-out skips indexing.
          const consent = (event.meta as any)?.searchConsent;
          if (consent?.explicitlySet === true && consent?.isPublic === false) {
            logger.debug('[SearchIndexerService] Skipping non-searchable activity (FEP-268d)', {
              activityId: (event.activity as any)?.id,
            });
            resolveOffset(message.offset);
            await heartbeat();
            continue;
          }

          await this.projector.onApFirehoseEvent(event);
        }

        resolveOffset(message.offset);
        await heartbeat();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[SearchIndexerService] Message processing error — activating backpressure', {
          topic: batch.topic,
          offset: message.offset,
          error: msg,
        });
        this.activateBackpressure(pause);
        return;
      }
    }
  }

  private activateBackpressure(pause: () => void): void {
    if (this.backpressureActive) return;
    this.backpressureActive = true;
    pause();
    logger.warn('[SearchIndexerService] Backpressure active — consumer paused', {
      retryInMs: this.config.backpressureRetryDelayMs,
    });
    setTimeout(() => {
      this.backpressureActive = false;
      logger.info('[SearchIndexerService] Backpressure cleared — consumer will resume on next poll');
    }, this.config.backpressureRetryDelayMs);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createSearchIndexerService(
  overrides?: Partial<SearchIndexerServiceConfig>,
  identityResolver?: IdentityAliasResolver,
): SearchIndexerService {
  const config: SearchIndexerServiceConfig = {
    brokers: (process.env['REDPANDA_BROKERS'] ?? 'localhost:9092').split(','),
    clientId: process.env['REDPANDA_CLIENT_ID'] ?? 'search-indexer',
    groupId: process.env['SEARCH_INDEXER_CONSUMER_GROUP'] ?? 'search-indexer-v1',
    firehoseTopic: process.env['REDPANDA_FIREHOSE_TOPIC'] ?? 'ap.firehose.v1',
    tombstoneTopic: process.env['REDPANDA_TOMBSTONE_TOPIC'] ?? 'ap.tombstones.v1',
    opensearchUrl: process.env['OPENSEARCH_URL'] ?? 'http://localhost:9200',
    opensearchUsername: process.env['OPENSEARCH_USERNAME'],
    opensearchPassword: process.env['OPENSEARCH_PASSWORD'],
    opensearchSslVerify: process.env['OPENSEARCH_SSL_VERIFY'] !== 'false',
    redis: null, // callers inject a Redis client if available
    backpressureRetryDelayMs: parseInt(
      process.env['SEARCH_INDEXER_BACKPRESSURE_RETRY_MS'] ?? '10000',
      10,
    ),
    ...overrides,
  };

  return new SearchIndexerService(config, identityResolver);
}
