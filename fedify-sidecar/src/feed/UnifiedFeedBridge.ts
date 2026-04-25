/**
 * UnifiedFeedBridge
 *
 * Produces the "unified" durable stream: a fully-normalized, canonical-schema
 * view of ALL public social content regardless of origin protocol.
 *
 * Sources consumed:
 *   canonical.v1             — local AP (→AT projected) + AT (→AP projected) intents
 *                              These arrive already serialized as CanonicalV1Event JSON.
 *   ap.stream2.remote-public.v1 — remote AP activities federated from external servers
 *                              (Mastodon, Pixelfed, etc.) that were never AT-projected.
 *                              These arrive as ActivityEvent JSON and are translated
 *                              into CanonicalV1Event shape before fan-out.
 *
 * Output:
 *   DurableStreamName "unified", schema "canonical.intent.v1" for all events.
 *
 * Crucially this bridge NEVER writes AT records or delivers AP activities —
 * it is observe-only. The TranslationContext it builds has identity-passthrough
 * resolvers that perform no network calls and no protocol writes.
 *
 * Error handling:
 *   - Invalid JSON / untranslatable activity → warn and skip (no crash).
 *   - Transient errors (broker timeout, LEADER_NOT_AVAILABLE, etc.) → rethrow so
 *     KafkaJS retries automatically (exponential backoff: 100ms × 2^n, max 8 retries).
 *   - Non-transient errors → log and skip to prevent queue stall.
 *
 * Consumer group: separate from FeedStreamKafkaConsumer so both run independently
 * and both receive every message on the shared topics.
 */

import { Kafka, logLevel, type Consumer, type EachBatchPayload } from "kafkajs";
import { logger } from "../utils/logger.js";
import type { DurableStreamSubscriptionService } from "./DurableStreamSubscriptionService.js";
import type { StreamEnvelope } from "./DurableStreamContracts.js";
import type { TranslationContext } from "../protocol-bridge/ports/ProtocolBridgePorts.js";
import { ActivityPubToCanonicalTranslator } from "../protocol-bridge/activitypub/ActivityPubToCanonicalTranslator.js";
import { serializeCanonicalIntent } from "../protocol-bridge/canonical/CanonicalIntentPublisher.js";
import { DefaultRetryClassifier } from "../protocol-bridge/workers/Retry.js";
import type { ActivityEvent } from "../streams/redpanda-producer.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface UnifiedFeedBridgeOptions {
  brokers: string[];
  clientId: string;
  /** Consumer group for this bridge — must not overlap with FeedStreamKafkaConsumer. */
  groupId: string;
  canonicalTopic: string;
  stream2Topic: string;
}

// ---------------------------------------------------------------------------
// Observe-only TranslationContext
// ---------------------------------------------------------------------------

/**
 * Identity-passthrough TranslationContext for remote AP observation.
 *
 * The AP→canonical translators call resolveActorRef/resolveObjectRef to enrich
 * partial references with canonical IDs, DIDs, etc. For remote AP actors we
 * have no DID and no canonical account — we simply return the input unchanged.
 * No network calls, no AT lookups, no side-effects.
 */
function buildObserveOnlyContext(): TranslationContext {
  return {
    resolveActorRef: async (ref) => ref,
    resolveObjectRef: async (ref) => ref,
  };
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function encodeCursor(partition: number, offset: string): string {
  return Buffer.from(JSON.stringify({ p: partition, o: offset })).toString("base64url");
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class UnifiedFeedBridge {
  private readonly consumers: Consumer[] = [];
  private readonly kafka: Kafka;
  private readonly retryClassifier = new DefaultRetryClassifier();
  private readonly translator = new ActivityPubToCanonicalTranslator();
  private readonly observeCtx: TranslationContext = buildObserveOnlyContext();
  private running = false;

  constructor(
    private readonly options: UnifiedFeedBridgeOptions,
    private readonly service: DurableStreamSubscriptionService,
  ) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      logLevel: logLevel.WARN,
      retry: {
        // Exponential backoff: 100ms base, max 8 attempts (~25s total ceiling)
        initialRetryTime: 100,
        retries: 8,
      },
    });
  }

  /**
   * Connect to both source topics and begin bridging to the unified stream.
   * Non-blocking — errors are logged so a broker hiccup at startup does not
   * prevent the HTTP server from accepting connections.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await Promise.all([
      this.startConsumer(
        `${this.options.groupId}-canonical`,
        this.options.canonicalTopic,
        (parsed, partition, offset) => this.handleCanonicalEvent(parsed, partition, offset),
      ),
      this.startConsumer(
        `${this.options.groupId}-stream2`,
        this.options.stream2Topic,
        (parsed, partition, offset) => this.handleStream2Event(parsed, partition, offset),
      ),
    ]);

    logger.info("UnifiedFeedBridge started", {
      groupId: this.options.groupId,
      topics: [this.options.canonicalTopic, this.options.stream2Topic],
    });
  }

  /** Gracefully disconnect all consumers. */
  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    await Promise.allSettled(
      this.consumers.map((c) =>
        c.disconnect().catch((err) => {
          logger.warn("UnifiedFeedBridge: error disconnecting consumer", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );

    logger.info("UnifiedFeedBridge stopped");
  }

  // -------------------------------------------------------------------------
  // Internal: consumer lifecycle
  // -------------------------------------------------------------------------

  private async startConsumer(
    groupId: string,
    topic: string,
    handler: (parsed: unknown, partition: number, offset: string) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      allowAutoTopicCreation: false,
    });

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.processBatch(payload, topic, handler),
    });

    this.consumers.push(consumer);
  }

  private async processBatch(
    payload: EachBatchPayload,
    topic: string,
    handler: (parsed: unknown, partition: number, offset: string) => Promise<void>,
  ): Promise<void> {
    const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale } = payload;

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) return;

      const raw = message.value?.toString("utf8");
      if (!raw) {
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn("UnifiedFeedBridge: invalid JSON, skipping", {
          topic,
          partition: batch.partition,
          offset: message.offset,
        });
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      try {
        await handler(parsed, batch.partition, message.offset);
      } catch (err) {
        if (this.retryClassifier.isTransient(err)) {
          // Re-throw so KafkaJS applies exponential back-off and retries.
          throw err;
        }
        logger.error("UnifiedFeedBridge: non-retryable error, skipping message", {
          topic,
          partition: batch.partition,
          offset: message.offset,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
    }
  }

  // -------------------------------------------------------------------------
  // Internal: event handlers
  // -------------------------------------------------------------------------

  /**
   * canonical.v1 events are already CanonicalV1Event — forward as-is to
   * the unified stream.
   */
  private async handleCanonicalEvent(
    parsed: unknown,
    partition: number,
    offset: string,
  ): Promise<void> {
    const event = parsed as Partial<{ canonicalIntentId: string; createdAt: string }>;
    if (!event.canonicalIntentId || !event.createdAt) {
      logger.warn("UnifiedFeedBridge: canonical event missing required fields, skipping", {
        canonicalIntentId: event.canonicalIntentId,
      });
      return;
    }

    const envelope: StreamEnvelope = {
      stream: "unified",
      eventId: event.canonicalIntentId,
      cursor: encodeCursor(partition, offset),
      occurredAt: event.createdAt,
      schema: "canonical.intent.v1",
      payload: parsed,
    };

    this.service.publish(envelope);
  }

  /**
   * stream2 events are ActivityEvent (raw AP). We translate the nested
   * `activity` object to CanonicalV1Event shape using the observe-only
   * TranslationContext (no AT writes, no network calls).
   */
  private async handleStream2Event(
    parsed: unknown,
    partition: number,
    offset: string,
  ): Promise<void> {
    const ev = parsed as Partial<ActivityEvent>;
    const activity = ev.activity;

    if (!activity || typeof activity !== "object") {
      return;
    }

    // Translate the raw AP activity object into a CanonicalIntent.
    const intent = await this.translator.translate(activity, this.observeCtx);
    if (!intent) {
      // Untranslatable activity type (e.g. Reject, Block, Move) — silently skip.
      return;
    }

    // Produce the same CanonicalV1Event wire format as CanonicalIntentPublisher.
    const v1Event = serializeCanonicalIntent(intent);

    const envelope: StreamEnvelope = {
      stream: "unified",
      eventId: intent.canonicalIntentId,
      cursor: encodeCursor(partition, offset),
      occurredAt: intent.createdAt,
      schema: "canonical.intent.v1",
      payload: v1Event,
    };

    this.service.publish(envelope);
  }
}
