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
import { createHash } from "node:crypto";
import type { Consumer, EachBatchPayload, Producer } from "kafkajs";
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
  /** Source-controlled rollout control; default FALSE until DLQ ACLs exist. */
  enableDeadLetter?: boolean;
  /** Must exist in governed Redpanda topics before enableDeadLetter=true. */
  deadLetterTopic?: string;
}

export interface CanonicalNotificationDeadLetter {
  publish(key: string, value: Buffer): Promise<void>;
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
export const CANONICAL_NOTIFICATION_DEAD_LETTER_TOPIC = "canonical.notifications.dlq.v1";
const MAX_QUARANTINE_RAW_BYTES = 262144;
const DEAD_LETTER_REASON = new Set([
  "EMPTY_RECORD", "INVALID_JSON", "INVALID_EVENT",
  "INVALID_PAYLOAD", "PERMANENT_HTTP_REJECTION"
]);
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
  private deadLetterProducer: Producer | null = null;
  private deadLetterPublisher: CanonicalNotificationDeadLetter | null;

  constructor(
    private readonly config: CanonicalNotificationConsumerConfig,
    private readonly logger: CanonicalNotificationLogger = NOOP_LOGGER,
    deadLetterPublisher: CanonicalNotificationDeadLetter | null = null,
  ) {
    this.deadLetterPublisher = deadLetterPublisher;
    if (config.deadLetterTopic &&
        config.deadLetterTopic !== CANONICAL_NOTIFICATION_DEAD_LETTER_TOPIC) {
      throw new Error("Unsupported canonical notification quarantine topic");
    }
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

    try {
      if (this.config.enableDeadLetter === true && !this.deadLetterPublisher) {
        // Explicit opt-in only. The DLQ topic must be provisioned with a
        // restricted ACL before enabling it for private notification events.
        this.deadLetterProducer = kafka.producer({
          allowAutoTopicCreation: false, idempotent: true,
          maxInFlightRequests: 1,
        });
        await this.deadLetterProducer.connect();
        const producer = this.deadLetterProducer;
        this.deadLetterPublisher = {
          publish: async (key: string, value: Buffer) => {
            await producer.send({
              topic: CANONICAL_NOTIFICATION_DEAD_LETTER_TOPIC,
              acks: -1, messages: [{ key, value }],
            });
          },
        };
      }
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: this.config.canonicalTopic });
      await this.consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        eachBatch: async (payload) => {
          await this.processBatch(payload);
        },
      });
    } catch (error) {
      await this.consumer.disconnect().catch(() => undefined);
      await this.deadLetterProducer?.disconnect().catch(() => undefined);
      this.consumer = null;
      this.deadLetterProducer = null;
      this.running = false;
      throw error;
    }

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
    if (this.deadLetterProducer) {
      await this.deadLetterProducer.disconnect();
      this.deadLetterProducer = null;
      this.deadLetterPublisher = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Batch processing
  // ---------------------------------------------------------------------------

  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const {
      batch, resolveOffset, heartbeat, commitOffsetsIfNecessary,
      isRunning, isStale,
    } = payload;
    const pending: Array<{ offset: string; promise: Promise<void> }> = [];
    const drain = async (): Promise<void> => {
      // Wait for ALL in-flight effects before acting on one Kafka offset.
      // Promise.all would reject early and leave unobserved in-flight calls.
      const results = await Promise.allSettled(pending.map(item => item.promise));
      const failure = results.find(
        (item): item is PromiseRejectedResult => item.status === "rejected",
      );
      if (failure) {
        // No offset is advanced across this window. Successful operations
        // replay and must be idempotent at the PostgreSQL notification ledger.
        throw failure.reason;
      }
      if (!isRunning() || isStale()) return;
      for (const item of pending) resolveOffset(item.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
      pending.length = 0;
    };

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;
      const key = `${batch.topic}:${batch.partition}:${message.offset}`;
      pending.push({
        offset: message.offset,
        promise: this.processRecord({
          key, raw: message.value ? Buffer.from(message.value) : null,
          sourceTopic: batch.topic, sourcePartition: batch.partition,
          sourceOffset: message.offset,
        }),
      });
      if (pending.length >= this.concurrency) await drain();
    }
    if (pending.length > 0) await drain();
  }

  private async processRecord({
    key, raw, sourceTopic, sourcePartition, sourceOffset,
  }: {
    key: string;
    raw: Buffer | null;
    sourceTopic: string;
    sourcePartition: number;
    sourceOffset: string;
  }): Promise<void> {
    if (!raw || raw.byteLength === 0) {
      await this.quarantine(key, raw, "EMPTY_RECORD", sourceTopic, sourcePartition, sourceOffset);
      return;
    }
    if (raw.byteLength > MAX_QUARANTINE_RAW_BYTES) {
      // Large private events cannot be safely duplicated to the DLQ.
      // Keep the original Kafka offset open for manual remediation.
      throw new Error("Canonical notification record exceeds the bounded quarantine size");
    }
    let event: unknown;
    try {
      event = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      await this.quarantine(key, raw, "INVALID_JSON", sourceTopic, sourcePartition, sourceOffset);
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      await this.quarantine(key, raw, "INVALID_EVENT", sourceTopic, sourcePartition, sourceOffset);
      return;
    }
    const value = event as Record<string, unknown>;
    if (typeof value["kind"] !== "string" ||
        value["kind"].length < 1 || value["kind"].length > 64) {
      await this.quarantine(key, raw, "INVALID_EVENT", sourceTopic, sourcePartition, sourceOffset);
      return;
    }
    // Non-notification canonical events never enter the notification
    // delivery route and do not need per-recipient processing.
    if (!NOTIFICATION_KINDS.has(value["kind"] as CanonicalV1Event["kind"])) return;
    if (typeof value["canonicalIntentId"] !== "string" ||
        value["canonicalIntentId"].length < 1 ||
        value["canonicalIntentId"].length > 512 ||
        typeof value["createdAt"] !== "string" ||
        !Number.isFinite(Date.parse(value["createdAt"])) ||
        (value["sourceProtocol"] !== "activitypub" && value["sourceProtocol"] !== "atproto") ||
        !value["actor"] || typeof value["actor"] !== "object" ||
        Array.isArray(value["actor"])) {
      await this.quarantine(key, raw, "INVALID_PAYLOAD", sourceTopic, sourcePartition, sourceOffset);
      return;
    }
    try {
      await this.fanOut(event as CanonicalV1Event);
    } catch (error) {
      // Retry dependency outages and all ambiguous responses. Only a
      // deterministic 400/413/422 rejection is eligible for quarantine.
      if (error instanceof CanonicalPermanentNotificationError) {
        await this.quarantine(key, raw, "PERMANENT_HTTP_REJECTION",
          sourceTopic, sourcePartition, sourceOffset);
        return;
      }
      throw error;
    }
  }

  private async quarantine(
    key: string, raw: Buffer | null, reason: string,
    sourceTopic: string, sourcePartition: number, sourceOffset: string,
  ): Promise<void> {
    if (!DEAD_LETTER_REASON.has(reason)) throw new Error("Invalid quarantine reason");
    if (raw && raw.byteLength > MAX_QUARANTINE_RAW_BYTES) {
      throw new Error("Oversized event cannot be quarantined");
    }
    if (this.config.enableDeadLetter !== true || !this.deadLetterPublisher) {
      // Never silently resolve a broken canonical event merely because the
      // quarantine producer is unavailable or disabled.
      throw new Error("Canonical notification quarantine not enabled; Kafka offset retained");
    }
    const record = Buffer.from(JSON.stringify({
      schema: "paper.canonical.notification.quarantine.v1",
      reason, sourceTopic, sourcePartition, sourceOffset,
      payloadSha256: createHash("sha256").update(raw || Buffer.alloc(0)).digest("hex"),
      // DLQ topic requires restricted read ACLs and short retention: this may
      // contain private notification payloads and must not be a public feed.
      rawBase64: raw ? raw.toString("base64") : "",
    }));
    await this.deadLetterPublisher.publish(key, record);
    this.logger.warn("Canonical notification parked in durable quarantine", {
      reason, sourceTopic, sourcePartition, sourceOffset,
    });
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
      if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
        throw new CanonicalPermanentNotificationError(statusCode);
      }
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

class CanonicalPermanentNotificationError extends Error {
  constructor(public readonly statusCode: number) {
    super("Permanent canonical notification payload rejection");
    this.name = "CanonicalPermanentNotificationError";
  }
}

function buildEndpointUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + path;
}