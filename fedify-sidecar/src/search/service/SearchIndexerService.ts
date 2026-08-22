/**
 * Dedicated public search projection consumer.
 *
 * Current OS3 architecture selects OpenSearch lexical/faceted storage by
 * default. Qdrant and dual modes remain explicit opt-in compatibility paths for
 * future vector experiments; they are not part of the default deployment.
 */

import { Kafka, Consumer, EachBatchPayload, logLevel } from 'kafkajs';
import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import { logger } from '../../utils/logger.js';
import { resolveSearchBackend } from '../../config/v6-config.js';
import { ApSearchProjector } from '../projectors/ApSearchProjector.js';
import { PublicContentIndexWriter } from '../writer/PublicContentIndexWriter.js';
import { PublicAuthorIndexWriter } from '../writer/PublicAuthorIndexWriter.js';
import { DefaultOpenSearchClient, DefaultOpenSearchAuthorClient } from '../writer/OpenSearchClient.js';
import { DefaultQdrantContentClient, NoopPublicAuthorStore } from '../writer/QdrantClient.js';
import { DefaultSearchDedupService } from '../aliases/SearchDedupService.js';
import {
  InMemorySearchDocAliasCache,
  RedisSearchDocAliasCache,
  type SearchDocAliasCache,
} from '../writer/SearchDocAliasCache.js';
import { SearchEventBus } from './SearchEventBus.js';
import type { IdentityAliasResolver, ResolvedIdentity } from '../identity/IdentityAliasResolver.js';
import type {
  SearchPublicUpsertV1,
  SearchPublicDeleteV1,
  SearchPublicDeleteByAuthorV1,
  SearchAuthorUpsertV1,
  SearchAuthorDeleteV1,
} from '../events/SearchEvents.js';
import { OutboxIntentDeduper, extractOutboxIntentId } from '../../utils/OutboxIntentDeduper.js';
import { normalizePublicSearchConsent } from '../../utils/searchConsent.js';
import { ensureRedpandaCompressionCodec } from '../../streams/kafka-compression.js';

export interface SearchIndexerServiceConfig {
  brokers: string[];
  clientId: string;
  groupId: string;
  firehoseTopic: string;
  tombstoneTopic: string;

  opensearchUrl: string;
  opensearchUsername?: string;
  opensearchPassword?: string;
  opensearchSslVerify: boolean;

  searchBackend: 'opensearch' | 'qdrant' | 'dual';
  qdrantUrl: string;
  qdrantApiKey?: string;
  qdrantCollectionName: string;
  qdrantVectorSize: number;
  qdrantRequestTimeoutMs: number;

  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  } | null;

  backpressureRetryDelayMs: number;
  outboxIntentDedupTtlSec: number;
}

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

export class SearchIndexerService {
  private readonly config: SearchIndexerServiceConfig;
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly bus: SearchEventBus;
  private readonly projector: ApSearchProjector;
  private readonly writer: PublicContentIndexWriter;
  private readonly authorWriter: PublicAuthorIndexWriter;
  private readonly contentStore: DefaultOpenSearchClient | DefaultQdrantContentClient;
  private readonly authorStore: DefaultOpenSearchAuthorClient | NoopPublicAuthorStore;
  private readonly outboxIntentDeduper: OutboxIntentDeduper;

  private isRunning = false;
  private backpressureActive = false;

  constructor(
    config: SearchIndexerServiceConfig,
    identityResolver?: IdentityAliasResolver,
  ) {
    this.config = config;

    ensureRedpandaCompressionCodec();

    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      logLevel: logLevel.WARN,
    });
    this.consumer = this.kafka.consumer({ groupId: config.groupId });

    const enableOpenSearch =
      config.searchBackend === 'opensearch' || config.searchBackend === 'dual';
    const enableQdrant =
      config.searchBackend === 'qdrant' || config.searchBackend === 'dual';

    let openSearchClient: DefaultOpenSearchClient | undefined;
    let authorClient: DefaultOpenSearchAuthorClient | undefined;

    if (enableOpenSearch) {
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
      openSearchClient = new DefaultOpenSearchClient(osNative);
      authorClient = new DefaultOpenSearchAuthorClient(osNative);
    }

    const qdrantClient = enableQdrant
      ? new DefaultQdrantContentClient({
          baseUrl: config.qdrantUrl,
          apiKey: config.qdrantApiKey,
          collectionName: config.qdrantCollectionName,
          vectorSize: config.qdrantVectorSize,
          requestTimeoutMs: config.qdrantRequestTimeoutMs,
        })
      : undefined;

    this.contentStore = qdrantClient ?? openSearchClient!;
    this.authorStore = authorClient ?? new NoopPublicAuthorStore();

    const aliasCache: SearchDocAliasCache = config.redis
      ? new RedisSearchDocAliasCache(config.redis)
      : new InMemorySearchDocAliasCache();

    const dedupService = new DefaultSearchDedupService(aliasCache);
    this.outboxIntentDeduper = new OutboxIntentDeduper({
      prefix: 'search:outbox-intent',
      ttlSeconds: config.outboxIntentDedupTtlSec,
      store: config.redis,
    });

    this.bus = new SearchEventBus();
    this.writer = new PublicContentIndexWriter(this.contentStore, aliasCache, dedupService);

    this.bus.on('search.public.upsert.v1', async (payload) => {
      await this.writer.onUpsert(payload as SearchPublicUpsertV1);
    });
    this.bus.on('search.public.delete.v1', async (payload) => {
      await this.writer.onDelete(payload as SearchPublicDeleteV1);
    });

    this.authorWriter = new PublicAuthorIndexWriter(this.authorStore);
    this.bus.on('search.public.delete-by-author.v1', async (payload) => {
      await this.writer.onDeleteByAuthor(payload as SearchPublicDeleteByAuthorV1);
    });
    this.bus.on('search.author.upsert.v1', async (payload) => {
      await this.authorWriter.onUpsert(payload as SearchAuthorUpsertV1);
    });
    this.bus.on('search.author.delete.v1', async (payload) => {
      await this.authorWriter.onDelete(payload as SearchAuthorDeleteV1);
    });

    const resolver = identityResolver ?? new PassThroughIdentityAliasResolver();
    this.projector = new ApSearchProjector(resolver, this.bus);
  }

  async initialize(): Promise<void> {
    if (this.contentStore instanceof DefaultOpenSearchClient) {
      await this.contentStore.initializeIndex();
    }
    if (this.authorStore instanceof DefaultOpenSearchAuthorClient) {
      await this.authorStore.initializeIndex();
    }

    logger.info('[SearchIndexerService] Search backend initialized', {
      backend: this.config.searchBackend,
    });
  }

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
      backend: this.config.searchBackend,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    await this.consumer.disconnect();
    logger.info('[SearchIndexerService] Stopped');
  }

  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, isRunning, isStale, pause } = payload;

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;

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
        const outboxIntentId = extractOutboxIntentId(
          event,
          message.headers as Record<string, Buffer | string | undefined> | undefined,
        );

        if (outboxIntentId) {
          const claimed = await this.outboxIntentDeduper.claim(outboxIntentId);
          if (!claimed) {
            logger.debug('[SearchIndexerService] Skipping duplicate local outbox intent replay', {
              outboxIntentId,
              topic: batch.topic,
              offset: message.offset,
            });
            resolveOffset(message.offset);
            await heartbeat();
            continue;
          }
        }

        if (batch.topic === this.config.tombstoneTopic) {
          await this.projector.onApTombstoneEvent(event);
        } else {
          const consent = normalizePublicSearchConsent((event['meta'] as any)?.searchConsent);
          if (consent?.isPublic === false) {
            logger.debug('[SearchIndexerService] Skipping non-searchable activity (FEP-268d)', {
              activityId: (event['activity'] as any)?.id,
              source: consent.source,
            });
            resolveOffset(message.offset);
            await heartbeat();
            continue;
          }

          await this.projector.onApFirehoseEvent(event);
        }

        resolveOffset(message.offset);
        await heartbeat();
      } catch (error: unknown) {
        logger.error('[SearchIndexerService] Message processing error — activating backpressure', {
          topic: batch.topic,
          offset: message.offset,
          error: error instanceof Error ? error.message : String(error),
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
    searchBackend: resolveSearchBackend(process.env['SEARCH_BACKEND']),
    qdrantUrl: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
    qdrantApiKey: process.env['QDRANT_API_KEY'],
    qdrantCollectionName: process.env['QDRANT_COLLECTION_NAME'] ?? 'public-content-v1',
    qdrantVectorSize: parseInt(process.env['QDRANT_VECTOR_SIZE'] ?? '1024', 10),
    qdrantRequestTimeoutMs: parseInt(process.env['QDRANT_REQUEST_TIMEOUT_MS'] ?? '5000', 10),
    redis: null,
    backpressureRetryDelayMs: parseInt(
      process.env['SEARCH_INDEXER_BACKPRESSURE_RETRY_MS'] ?? '10000',
      10,
    ),
    outboxIntentDedupTtlSec: parseInt(
      process.env['SEARCH_INDEXER_OUTBOX_INTENT_DEDUP_TTL_SEC'] ?? `${60 * 60 * 24 * 7}`,
      10,
    ),
    ...overrides,
  };

  return new SearchIndexerService(config, identityResolver);
}
