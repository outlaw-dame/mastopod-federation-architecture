/**
 * CanonicalNotificationConsumer
 *
 * KafkaJS consumer that subscribes to `canonical.v1` and fans out in-app
 * notifications to ActivityPods for local actor recipients.
 *
 * Notification-class intents handled:
 *   ReactionAdd   — someone liked a local user's post
 *   ShareAdd      — someone boosted a local user's post
 *   FollowAdd     — someone followed a local user
 *   PostCreate    — someone created a post that mentions a local user
 *
 * For each matching event this consumer calls ActivityPods:
 *   POST /api/internal/bridge/canonical-notification
 *
 * ActivityPods is responsible for:
 *   1. Checking whether the recipient is a local actor
 *   2. Resolving notification content (actor display name, object preview)
 *   3. Creating the in-app notification record
 *   4. Optionally triggering push (WebPush / SSE)
 *
 * Design goals:
 *   - Replayable: HTTP delivery errors propagate, so Kafka offsets are not
 *     committed before ActivityPods acknowledges processing.
 *   - Protocol-neutral: no ActivityPub or ATProto parsing logic here
 *   - At-least-once: ActivityPods still needs durable per-recipient dedupe
 */

import { Kafka, logLevel } from "kafkajs";
import type { Consumer, EachBatchPayload } from "kafkajs";
import { request } from "undici";
import type { CanonicalV1Event } from "../../streams/v6-topology.js";
import { ensureRedpandaCompressionCodec } from "../../streams/kafka-compression.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CanonicalNotificationConsumerConfig {
  brokers: string[];
  clientId: string;
  consumerGroupId: string;
  canonicalTopic: string;
  activityPodsBaseUrl: string;
  activityPodsBearerToken: string;
  /** Timeout for each ActivityPods notification call. Default: 10_000 ms. */
  notifyTimeoutMs?: number;
  /** Maximum notification calls in parallel per batch. Default: 4. */
  concurrency?: number;
}

export interface CanonicalNotificationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: CanonicalNotificationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// The set of intent kinds that generate actionable notifications.
const NOTIFICATION_KINDS = new Set<CanonicalV1Event["kind"]>([
  "ReactionAdd",
  "ShareAdd",
  "FollowAdd",
  "PostCreate",
]);

// ---------------------------------------------------------------------------
// Notification payload sent to ActivityPods
// ---------------------------------------------------------------------------

/**
 * POST /api/internal/bridge/canonical-notification
 *
 * ActivityPods uses this payload to:
 *   - Look up the relevant local actor (via object owner or follow subject)
 *   - Build the in-app notification
 *   - Optionally send push
 *
 * ActivityPods MUST implement this endpoint. A 404 or temporary outage is
 * NOT successful delivery; keep the Kafka offset unresolved until recovered.
 */
export interface CanonicalNotificationPayload {
  /** Unique intent ID — ActivityPods deduplicates on this. */
  canonicalIntentId: string;
  /** Type of notification. */
  kind: CanonicalV1Event["kind"];
  /** Protocol the action originated from. */
  sourceProtocol: CanonicalV1Event["sourceProtocol"];
  /** The actor who performed the action. */
  actor: CanonicalV1Event["actor"];
  /**
   * Object being acted on (for reactions, shares, post with mentions).
   * Absent for FollowAdd.
   */
  object?: CanonicalV1Event["object"];
  /**
   * Actor being followed (for FollowAdd — the local user receiving the follow).
   */
  subject?: CanonicalV1Event["subject"];
  /**
   * AP actor URIs mentioned in the post (PostCreate only).
   * ActivityPods sends a mention notification to each.
   */
  mentions?: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Consumer class
// ---------------------------------------------------------------------------

export class CanonicalNotificationConsumer {
  private consumer: Consumer | null = null;
  private running = false;
  private readonly notifyTimeoutMs: number;
  private readonly concurrency: number;
  private readonly endpointUrl: string;

  constructor(
    private readonly config: CanonicalNotificationConsumerConfig,
    private readonly logger: CanonicalNotificationLogger = NOOP_LOGGER,
  ) {
    const requestedTimeout = config.notifyTimeoutMs ?? 10_000;
    const requestedConcurrency = config.concurrency ?? 4;
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 500 ||
        requestedTimeout > 30_000 || !Number.isSafeInteger(requestedConcurrency) ||
        requestedConcurrency < 1 || requestedConcurrency > 8) {
      throw new Error("Invalid canonical notification consumer timeout/concurrency budget");
    }
    this.notifyTimeoutMs = requestedTimeout;
    this.concurrency = requestedConcurrency;
    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      "/api/internal/bridge/canonical-notification",
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // canonical.v1 can contain producer-compressed Zstd batches. This consumer
    // is independently constructible, so register the decoder here rather than
    // relying on another sidecar component to have initialized KafkaJS first.
    ensureRedpandaCompressionCodec();

    const kafka = new Kafka({
      clientId: `${this.config.clientId}-canonical-notifications`,
      brokers: this.config.brokers,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 100, retries: 8 },
    });

    this.consumer = kafka.consumer({
      groupId: this.config.consumerGroupId,
      allowAutoTopicCreation: false,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.config.canonicalTopic });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        await this.processBatch(payload);
      },
    });

    this.logger.info("CanonicalNotificationConsumer started", {
      topic: this.config.canonicalTopic,
      groupId: this.config.consumerGroupId,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.consumer) {
      try { await this.consumer.stop(); } catch { /* best-effort */ }
      try { await this.consumer.disconnect(); } catch { /* best-effort */ }
      this.consumer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Batch processing
  // ---------------------------------------------------------------------------

  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const {
      batch,
      resolveOffset,
      heartbeat,
      commitOffsetsIfNecessary,
      isRunning,
      isStale,
    } = payload;

    const pending: Array<{ offset: string; promise: Promise<void> }> = [];

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;

      const raw = message.value?.toString("utf8")?.trim();
      if (!raw) {
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      let event: CanonicalV1Event;
      try {
        event = JSON.parse(raw) as CanonicalV1Event;
      } catch {
        this.logger.warn("canonical.v1 message could not be parsed — skipping", {
          offset: message.offset,
        });
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      if (!NOTIFICATION_KINDS.has(event.kind)) {
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      // Never swallow a delivery failure and then resolve its Kafka offset.
      // Promise.all below leaves the entire uncommitted batch replayable;
      // ActivityPods must tolerate at-least-once duplicates during recovery.
      const p = this.fanOut(event);

      pending.push({ offset: message.offset, promise: p });

      // Drain once we hit concurrency limit
      if (pending.length >= this.concurrency) {
        await Promise.all(pending.map((e) => e.promise));
        for (const e of pending) {
          resolveOffset(e.offset);
        }
        await commitOffsetsIfNecessary();
        await heartbeat();
        pending.length = 0;
      }
    }

    // Drain remaining
    if (pending.length > 0) {
      await Promise.all(pending.map((e) => e.promise));
      for (const e of pending) {
        resolveOffset(e.offset);
      }
      await commitOffsetsIfNecessary();
      await heartbeat();
    }
  }

  // ---------------------------------------------------------------------------
  // Notification fan-out
  // ---------------------------------------------------------------------------

  private async fanOut(event: CanonicalV1Event): Promise<void> {
    const payload: CanonicalNotificationPayload = {
      canonicalIntentId: event.canonicalIntentId,
      kind: event.kind,
      sourceProtocol: event.sourceProtocol,
      actor: event.actor,
      createdAt: event.createdAt,
    };

    if (event.object) payload.object = event.object;
    if (event.subject) payload.subject = event.subject;
    if (event.mentions && event.mentions.length > 0) payload.mentions = event.mentions;

    await this.callActivityPods(payload);
  }

  private async callActivityPods(payload: CanonicalNotificationPayload): Promise<void> {
    let statusCode: number;

    try {
      const res = await request(this.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.activityPodsBearerToken}`,
        },
        body: JSON.stringify(payload),
        bodyTimeout: this.notifyTimeoutMs,
        headersTimeout: this.notifyTimeoutMs,
      });
      statusCode = res.statusCode;
      // Drain the short internal API response for connection reuse, without
      // using its untrusted body as proof of acceptance or logging it.
      await res.body.dump({ limit: 262144 });
    } catch (err) {
      this.logger.error("ActivityPods canonical-notification HTTP error", {
        canonicalIntentId: payload.canonicalIntentId,
        kind: payload.kind,
        error: err instanceof Error ? err.name : "UNKNOWN_HTTP_ERROR",
      });
      throw new Error("Canonical notification transport failed; Kafka offset remains unresolved");
    }

    if (statusCode === 409) {
      this.logger.info("Canonical notification already delivered (idempotent)", {
        canonicalIntentId: payload.canonicalIntentId,
      });
      return;
    }

    if (statusCode !== 202) {
      // The ActivityPods bridge documents durable processing acknowledgment
      // as 202 and duplicate completion as 409. 404, 429, 500 and even a
      // generic 200 must not be treated as a successful handoff.
      this.logger.error("ActivityPods canonical notification not accepted", {
        canonicalIntentId: payload.canonicalIntentId,
        kind: payload.kind,
        statusCode,
      });
      throw new Error("Canonical notification not accepted; Kafka offset remains unresolved");
    }

    this.logger.info("Canonical notification delivered", {
      canonicalIntentId: payload.canonicalIntentId,
      kind: payload.kind,
      sourceProtocol: payload.sourceProtocol,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEndpointUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + path;
}