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
 *   - Fault-isolated: HTTP errors are logged, never crash the consumer
 *   - Protocol-neutral: no ActivityPub or ATProto parsing logic here
 *   - Idempotent: ActivityPods deduplicates by canonicalIntentId
 */

import { Kafka, logLevel } from "kafkajs";
import type { Consumer, EachBatchPayload } from "kafkajs";
import { request } from "undici";
import type { CanonicalV1Event } from "../../streams/v6-topology.js";

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
 * ActivityPods MUST implement this endpoint.  If it returns 404 the consumer
 * logs a warning (not an error) so the pipeline is not interrupted during
 * incremental rollout.
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
    this.notifyTimeoutMs = config.notifyTimeoutMs ?? 10_000;
    this.concurrency = config.concurrency ?? 4;
    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      "/api/internal/bridge/canonical-notification",
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

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

      // Fan-out: fire the notification call fault-isolated.
      const p = this.fanOut(event).catch((err) => {
        this.logger.error("Canonical notification fan-out unhandled error", {
          canonicalIntentId: event.canonicalIntentId,
          kind: event.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      });

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
    let bodyText: string;

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
      bodyText = await res.body.text().catch(() => "");
    } catch (err) {
      this.logger.error("ActivityPods canonical-notification HTTP error", {
        canonicalIntentId: payload.canonicalIntentId,
        kind: payload.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return; // fault-isolated
    }

    if (statusCode === 404) {
      // Endpoint not yet implemented — log once at warn, not error.
      this.logger.warn(
        "ActivityPods /api/internal/bridge/canonical-notification returned 404 — endpoint not yet implemented",
        { canonicalIntentId: payload.canonicalIntentId },
      );
      return;
    }

    if (statusCode === 409) {
      // Duplicate — already processed (idempotency).
      this.logger.info("Canonical notification already delivered (idempotent)", {
        canonicalIntentId: payload.canonicalIntentId,
      });
      return;
    }

    if (statusCode < 200 || statusCode >= 300) {
      this.logger.error("ActivityPods canonical-notification returned non-2xx", {
        canonicalIntentId: payload.canonicalIntentId,
        kind: payload.kind,
        statusCode,
        body: bodyText.slice(0, 256),
      });
      return;
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
