/**
 * Dedicated public search projection consumer.
 *
 * OS4 designates this TypeScript projector as the canonical Redpanda -> public
 * search ingestion path. OS4b opportunistically batches only consecutive AP
 * Create/Note projections already present in the same Kafka batch. No timer is
 * introduced: low-volume events are processed immediately, while high-volume
 * batches use the measured 100-document OpenSearch bulk knee.
 */

import { Kafka, Consumer, Producer, EachBatchPayload, IHeaders, logLevel } from 'kafkajs';
import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import { logger } from '../../utils/logger.js';
import { resolveSearchBackend } from '../../config/v6-config.js';
import { ApSearchProjector } from '../projectors/ApSearchProjector.js';
import { PublicContentBatchError, PublicContentIndexWriter } from '../writer/PublicContentIndexWriter.js';
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
import { collectApFirehoseEvents } from './ApSearchProjectionCollector.js';
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
  dlqTopic: string;
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
  maxProcessingAttempts: number;
  maxBatchSize: number;
  outboxIntentDedupTtlSec: number;
}

class PassThroughIdentityAliasResolver implements IdentityAliasResolver {
  async resolveByCanonicalId(canonicalId: string): Promise<ResolvedIdentity> { return { canonicalId }; }
  async resolveByApUri(apUri: string): Promise<ResolvedIdentity> { return { apUri }; }
  async resolveByAtDid(did: string): Promise<ResolvedIdentity> { return { atDid: did }; }
}

type KafkaBatchMessage = EachBatchPayload['batch']['messages'][number];

interface ContentPlan {
  message: KafkaBatchMessage;
  raw: string;
  retryKey: string;
  outboxIntentId?: string;
  upsert?: SearchPublicUpsertV1;
  alreadyCompleted?: boolean;
}

export class SearchIndexerService {
  private readonly config: SearchIndexerServiceConfig;
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  private readonly bus: SearchEventBus;
  private readonly projector: ApSearchProjector;
  private readonly identityResolver: IdentityAliasResolver;
  private readonly writer: PublicContentIndexWriter;
  private readonly authorWriter: PublicAuthorIndexWriter;
  private readonly contentStore: DefaultOpenSearchClient | DefaultQdrantContentClient;
  private readonly authorStore: DefaultOpenSearchAuthorClient | NoopPublicAuthorStore;
  private readonly outboxIntentDeduper: OutboxIntentDeduper;
  private readonly processingAttempts = new Map<string, number>();
  private isRunning = false;
  private backpressureActive = false;

  constructor(config: SearchIndexerServiceConfig, identityResolver?: IdentityAliasResolver) {
    this.config = config;
    this.identityResolver = identityResolver ?? new PassThroughIdentityAliasResolver();
    ensureRedpandaCompressionCodec();
    this.kafka = new Kafka({ clientId: config.clientId, brokers: config.brokers, logLevel: logLevel.WARN });
    this.consumer = this.kafka.consumer({ groupId: config.groupId });
    this.producer = this.kafka.producer();

    const enableOpenSearch = config.searchBackend === 'opensearch' || config.searchBackend === 'dual';
    const enableQdrant = config.searchBackend === 'qdrant' || config.searchBackend === 'dual';
    let openSearchClient: DefaultOpenSearchClient | undefined;
    let authorClient: DefaultOpenSearchAuthorClient | undefined;

    if (enableOpenSearch) {
      const osNative = new OpenSearchNativeClient(
        config.opensearchUsername
          ? { node: config.opensearchUrl, auth: { username: config.opensearchUsername, password: config.opensearchPassword ?? '' }, ssl: { rejectUnauthorized: config.opensearchSslVerify } }
          : { node: config.opensearchUrl, ssl: { rejectUnauthorized: config.opensearchSslVerify } },
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
      prefix: 'search:completed-outbox-intent:v1',
      ttlSeconds: config.outboxIntentDedupTtlSec,
      store: config.redis,
    });

    this.bus = new SearchEventBus();
    this.writer = new PublicContentIndexWriter(this.contentStore, aliasCache, dedupService);
    this.bus.on('search.public.upsert.v1', async (payload) => { await this.writer.onUpsert(payload as SearchPublicUpsertV1); });
    this.bus.on('search.public.delete.v1', async (payload) => { await this.writer.onDelete(payload as SearchPublicDeleteV1); });
    this.authorWriter = new PublicAuthorIndexWriter(this.authorStore);
    this.bus.on('search.public.delete-by-author.v1', async (payload) => { await this.writer.onDeleteByAuthor(payload as SearchPublicDeleteByAuthorV1); });
    this.bus.on('search.author.upsert.v1', async (payload) => { await this.authorWriter.onUpsert(payload as SearchAuthorUpsertV1); });
    this.bus.on('search.author.delete.v1', async (payload) => { await this.authorWriter.onDelete(payload as SearchAuthorDeleteV1); });
    this.projector = new ApSearchProjector(this.identityResolver, this.bus);
  }

  async initialize(): Promise<void> {
    if (this.contentStore instanceof DefaultOpenSearchClient) await this.contentStore.initializeIndex();
    if (this.authorStore instanceof DefaultOpenSearchAuthorClient) await this.authorStore.initializeIndex();
    logger.info('[SearchIndexerService] Search backend initialized', { backend: this.config.searchBackend });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [this.config.firehoseTopic, this.config.tombstoneTopic], fromBeginning: false });
    await this.consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async (payload: EachBatchPayload) => { await this.processBatch(payload); },
    });
    logger.info('[SearchIndexerService] Started', {
      firehoseTopic: this.config.firehoseTopic,
      tombstoneTopic: this.config.tombstoneTopic,
      dlqTopic: this.config.dlqTopic,
      groupId: this.config.groupId,
      backend: this.config.searchBackend,
      maxProcessingAttempts: this.config.maxProcessingAttempts,
      maxBatchSize: this.config.maxBatchSize,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    await this.consumer.disconnect();
    await this.producer.disconnect();
    logger.info('[SearchIndexerService] Stopped');
  }

  private async markCompleted(outboxIntentId: string | undefined): Promise<void> {
    if (!outboxIntentId) return;
    await this.outboxIntentDeduper.claim(outboxIntentId);
  }

  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, isRunning, isStale } = payload;
    let cursor = 0;

    while (cursor < batch.messages.length) {
      if (!isRunning() || isStale() || this.backpressureActive) return;
      const message = batch.messages[cursor]!;

      if (this.canUseContentBatch(batch.topic, message)) {
        const group: KafkaBatchMessage[] = [];
        while (
          cursor + group.length < batch.messages.length &&
          group.length < this.config.maxBatchSize &&
          this.canUseContentBatch(batch.topic, batch.messages[cursor + group.length]!)
        ) {
          group.push(batch.messages[cursor + group.length]!);
        }

        const result = await this.processContentGroup(group, payload);
        cursor += Math.max(1, result.processed);
        if (result.halted) return;
        continue;
      }

      const halted = await this.processSingleMessage(message, payload);
      cursor += 1;
      if (halted) return;
    }
  }

  private canUseContentBatch(topic: string, message: KafkaBatchMessage): boolean {
    if (!(this.contentStore instanceof DefaultOpenSearchClient)) return false;
    if (this.config.maxBatchSize < 2 || topic !== this.config.firehoseTopic) return false;
    const raw = message.value?.toString();
    if (!raw) return false;
    try {
      const source = JSON.parse(raw) as any;
      return source?.activity?.type === 'Create' && source?.activity?.object?.type === 'Note';
    } catch {
      return false;
    }
  }

  private async processContentGroup(
    messages: KafkaBatchMessage[],
    payload: EachBatchPayload,
  ): Promise<{ processed: number; halted: boolean }> {
    const plans: ContentPlan[] = [];
    let planningFailure: { index: number; raw: string; retryKey: string; error: unknown } | null = null;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      const raw = message.value?.toString() ?? '';
      const retryKey = `${payload.batch.topic}:${payload.batch.partition}:${message.offset}`;
      try {
        const event = JSON.parse(raw) as Record<string, unknown>;
        const outboxIntentId = extractOutboxIntentId(
          event,
          message.headers as Record<string, Buffer | string | undefined> | undefined,
        );

        if (
          outboxIntentId
          && await this.runWithHeartbeat(
            () => this.outboxIntentDeduper.has(outboxIntentId),
            payload,
          )
        ) {
          plans.push({ message, raw, retryKey, outboxIntentId, alreadyCompleted: true });
          continue;
        }

        const consent = normalizePublicSearchConsent((event['meta'] as any)?.searchConsent);
        if (consent?.isPublic === false) {
          plans.push({ message, raw, retryKey, outboxIntentId });
          await payload.heartbeat();
          continue;
        }

        const projected = await this.runWithHeartbeat(
          () => collectApFirehoseEvents(this.identityResolver, event),
          payload,
        );
        if (projected.length === 0) {
          plans.push({ message, raw, retryKey, outboxIntentId });
          continue;
        }
        if (projected.length !== 1 || projected[0]!.topic !== 'search.public.upsert.v1') {
          throw new Error('AP Create/Note produced a non-batchable search projection');
        }
        plans.push({
          message,
          raw,
          retryKey,
          outboxIntentId,
          upsert: projected[0]!.event as SearchPublicUpsertV1,
        });
      } catch (error) {
        planningFailure = { index: i, raw, retryKey, error };
        break;
      }
    }

    const plannedCount = planningFailure ? planningFailure.index : plans.length;
    const upsertPlanIndexes: number[] = [];
    const upserts: SearchPublicUpsertV1[] = [];
    for (let i = 0; i < plannedCount; i++) {
      if (plans[i]!.upsert) {
        upsertPlanIndexes.push(i);
        upserts.push(plans[i]!.upsert!);
      }
    }

    let failedPlanIndex: number | null = null;
    let batchError: unknown;
    if (upserts.length > 0) {
      try {
        await this.runWithHeartbeat(() => this.writer.onUpsertBatch(upserts), payload);
        logger.info('[SearchIndexerService] Applied OpenSearch content batch', {
          contentBatchSize: upserts.length,
          topic: payload.batch.topic,
          partition: payload.batch.partition,
        });
      } catch (error) {
        batchError = error;
        const failedUpsertIndex = error instanceof PublicContentBatchError ? error.failedIndex : 0;
        failedPlanIndex = upsertPlanIndexes[Math.max(0, Math.min(failedUpsertIndex, upsertPlanIndexes.length - 1))] ?? 0;
      }
    }

    const successLimit = failedPlanIndex == null ? plannedCount : failedPlanIndex;
    for (let i = 0; i < successLimit; i++) {
      try {
        await this.finalizePlan(plans[i]!, payload);
      } catch (error) {
        const halted = await this.handleFailure(plans[i]!.message, plans[i]!.raw, plans[i]!.retryKey, error, payload);
        return { processed: i + (halted ? 0 : 1), halted };
      }
    }

    if (failedPlanIndex != null) {
      const failedPlan = plans[failedPlanIndex]!;
      const halted = await this.handleFailure(
        failedPlan.message,
        failedPlan.raw,
        failedPlan.retryKey,
        batchError,
        payload,
      );
      return { processed: failedPlanIndex + (halted ? 0 : 1), halted };
    }

    if (planningFailure) {
      const failedMessage = messages[planningFailure.index]!;
      const halted = await this.handleFailure(
        failedMessage,
        planningFailure.raw,
        planningFailure.retryKey,
        planningFailure.error,
        payload,
      );
      return { processed: plannedCount + (halted ? 0 : 1), halted };
    }

    return { processed: plannedCount, halted: false };
  }

  private async runWithHeartbeat<T>(work: () => Promise<T>, payload: EachBatchPayload): Promise<T> {
    let heartbeatError: unknown;
    const timer = setInterval(() => {
      void payload.heartbeat().catch((error) => {
        heartbeatError ??= error;
      });
    }, 3_000);
    try {
      const result = await work();
      if (heartbeatError) throw heartbeatError;
      await payload.heartbeat();
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async finalizePlan(plan: ContentPlan, payload: EachBatchPayload): Promise<void> {
    if (!plan.alreadyCompleted) await this.markCompleted(plan.outboxIntentId);
    payload.resolveOffset(plan.message.offset);
    this.processingAttempts.delete(plan.retryKey);
    await payload.heartbeat();
  }

  private async processSingleMessage(message: KafkaBatchMessage, payload: EachBatchPayload): Promise<boolean> {
    const { batch, resolveOffset, heartbeat } = payload;
    const retryKey = `${batch.topic}:${batch.partition}:${message.offset}`;
    let raw: string | undefined;
    let outboxIntentId: string | undefined;

    try {
      raw = message.value?.toString();
      if (!raw) {
        resolveOffset(message.offset);
        this.processingAttempts.delete(retryKey);
        return false;
      }

      const event = JSON.parse(raw) as Record<string, unknown>;
      outboxIntentId = extractOutboxIntentId(
        event,
        message.headers as Record<string, Buffer | string | undefined> | undefined,
      );

      if (outboxIntentId && await this.outboxIntentDeduper.has(outboxIntentId)) {
        logger.debug('[SearchIndexerService] Skipping completed local outbox intent replay', {
          outboxIntentId, topic: batch.topic, partition: batch.partition, offset: message.offset,
        });
        resolveOffset(message.offset);
        this.processingAttempts.delete(retryKey);
        await heartbeat();
        return false;
      }

      if (batch.topic === this.config.tombstoneTopic) {
        await this.projector.onApTombstoneEvent(event);
      } else {
        const consent = normalizePublicSearchConsent((event['meta'] as any)?.searchConsent);
        if (consent?.isPublic === false) {
          logger.debug('[SearchIndexerService] Skipping non-searchable activity (FEP-268d)', {
            activityId: (event['activity'] as any)?.id, source: consent.source,
          });
          await this.markCompleted(outboxIntentId);
          resolveOffset(message.offset);
          this.processingAttempts.delete(retryKey);
          await heartbeat();
          return false;
        }
        await this.projector.onApFirehoseEvent(event);
      }

      await this.markCompleted(outboxIntentId);
      resolveOffset(message.offset);
      this.processingAttempts.delete(retryKey);
      await heartbeat();
      return false;
    } catch (error) {
      return this.handleFailure(message, raw, retryKey, error, payload);
    }
  }

  private async handleFailure(
    message: KafkaBatchMessage,
    raw: string | undefined,
    retryKey: string,
    error: unknown,
    payload: EachBatchPayload,
  ): Promise<boolean> {
    const attempts = (this.processingAttempts.get(retryKey) ?? 0) + 1;
    this.processingAttempts.set(retryKey, attempts);
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (attempts >= this.config.maxProcessingAttempts && raw) {
      await this.publishDlq(
        payload.batch.topic,
        payload.batch.partition,
        message.offset,
        raw,
        message.headers,
        errorMessage,
        attempts,
      );
      payload.resolveOffset(message.offset);
      this.processingAttempts.delete(retryKey);
      await payload.heartbeat();
      logger.error('[SearchIndexerService] Poison search event moved to DLQ', {
        topic: payload.batch.topic,
        partition: payload.batch.partition,
        offset: message.offset,
        dlqTopic: this.config.dlqTopic,
        attempts,
        error: errorMessage,
      });
      return false;
    }

    logger.warn('[SearchIndexerService] Message processing failed — pausing before replay', {
      topic: payload.batch.topic,
      partition: payload.batch.partition,
      offset: message.offset,
      attempts,
      maxAttempts: this.config.maxProcessingAttempts,
      error: errorMessage,
    });
    this.activateBackpressure(payload.pause);
    return true;
  }

  private async publishDlq(
    sourceTopic: string,
    partition: number,
    offset: string,
    raw: string,
    originalHeaders: IHeaders | undefined,
    error: string,
    attempts: number,
  ): Promise<void> {
    const headers: IHeaders = {
      ...originalHeaders,
      'search-dlq-source-topic': sourceTopic,
      'search-dlq-source-partition': String(partition),
      'search-dlq-source-offset': offset,
      'search-dlq-error': error.slice(0, 1024),
      'search-dlq-attempts': String(attempts),
      'search-dlq-failed-at': new Date().toISOString(),
    };
    await this.producer.send({ topic: this.config.dlqTopic, messages: [{ value: raw, headers }] });
  }

  private activateBackpressure(pause: () => () => void): void {
    if (this.backpressureActive) return;
    this.backpressureActive = true;
    const resume = pause();
    logger.warn('[SearchIndexerService] Backpressure active — consumer paused', { retryInMs: this.config.backpressureRetryDelayMs });
    setTimeout(() => {
      if (!this.isRunning) return;
      this.backpressureActive = false;
      resume();
      logger.info('[SearchIndexerService] Backpressure cleared — consumer resumed');
    }, this.config.backpressureRetryDelayMs);
  }
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
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
    dlqTopic: process.env['SEARCH_INDEXER_DLQ_TOPIC'] ?? 'ap.firehose.dlq.v1',
    opensearchUrl: process.env['OPENSEARCH_URL'] ?? 'http://localhost:9200',
    opensearchUsername: process.env['OPENSEARCH_USERNAME'],
    opensearchPassword: process.env['OPENSEARCH_PASSWORD'],
    opensearchSslVerify: process.env['OPENSEARCH_SSL_VERIFY'] !== 'false',
    searchBackend: resolveSearchBackend(process.env['SEARCH_BACKEND']),
    qdrantUrl: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
    qdrantApiKey: process.env['QDRANT_API_KEY'],
    qdrantCollectionName: process.env['QDRANT_COLLECTION_NAME'] ?? 'public-content-v1',
    qdrantVectorSize: parseBoundedInteger(process.env['QDRANT_VECTOR_SIZE'], 1024, 1, 65_536),
    qdrantRequestTimeoutMs: parseBoundedInteger(process.env['QDRANT_REQUEST_TIMEOUT_MS'], 5_000, 1, 600_000),
    redis: null,
    backpressureRetryDelayMs: parseBoundedInteger(process.env['SEARCH_INDEXER_BACKPRESSURE_RETRY_MS'], 10_000, 1, 600_000),
    maxProcessingAttempts: parseBoundedInteger(process.env['SEARCH_INDEXER_MAX_PROCESSING_ATTEMPTS'], 5, 1, 100),
    maxBatchSize: parseBoundedInteger(process.env['SEARCH_INDEXER_MAX_BATCH_SIZE'], 100, 1, 100),
    outboxIntentDedupTtlSec: parseBoundedInteger(
      process.env['SEARCH_INDEXER_OUTBOX_INTENT_DEDUP_TTL_SEC'],
      60 * 60 * 24 * 7,
      1,
      60 * 60 * 24 * 365,
    ),
    ...overrides,
  };
  return new SearchIndexerService(config, identityResolver);
}