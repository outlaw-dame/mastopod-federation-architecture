/**
 * FeedStreamKafkaConsumer
 *
 * Bridges the three ActivityPods Kafka topics into the
 * DurableStreamSubscriptionService fan-out, making their events available
 * to SSE and WebSocket clients via GET /internal/feed/stream.
 *
 * Topic → DurableStreamName mapping:
 *   ap.stream1.local-public.v1   → "stream1"  (local public ActivityEvents)
 *   ap.stream2.remote-public.v1  → "stream2"  (remote public ActivityEvents)
 *   canonical.v1                 → "canonical" (CanonicalV1Events)
 *
 * Firehose (ap.firehose.v1) is intentionally excluded from the default set
 * because it contains the same messages as stream1 + stream2 combined.
 * Pass enabledStreams: ["stream1","stream2","canonical","firehose"] to opt in.
 *
 * Message mapping:
 *   ActivityEvent  → StreamEnvelope with schema "ap.activity.v1"
 *   CanonicalV1Event → StreamEnvelope with schema "canonical.intent.v1"
 *
 * Cursor format: base64url-encoded JSON { p: partition, o: offset }
 */

import { Kafka, logLevel, type Consumer } from "kafkajs";
import { logger } from "../utils/logger.js";
import type { DurableStreamSubscriptionService } from "./DurableStreamSubscriptionService.js";
import type { DurableStreamName, StreamEnvelope } from "./DurableStreamContracts.js";
import type { ActivityEvent } from "../streams/redpanda-producer.js";
import type { CanonicalV1Event } from "../streams/v6-topology.js";

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

export interface FeedStreamKafkaConsumerOptions {
  brokers: string[];
  clientId: string;
  /** Kafka consumer group. Use a dedicated group so offsets are tracked independently. */
  groupId: string;

  // Topic names (resolved from env by the caller)
  stream1Topic: string;
  stream2Topic: string;
  canonicalTopic: string;
  firehoseTopic: string;

  /**
   * Which DurableStreamNames to consume.
   * Defaults to ["stream1", "stream2", "canonical"].
   * Include "firehose" only if you specifically need a merged stream without
   * also subscribing to stream1 / stream2.
   */
  enabledStreams?: ReadonlyArray<DurableStreamName>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Encode a Kafka partition + offset into an opaque cursor string. */
function encodeCursor(partition: number, offset: string): string {
  return Buffer.from(JSON.stringify({ p: partition, o: offset })).toString("base64url");
}

/**
 * Map a raw Kafka message value (already parsed) to a StreamEnvelope.
 * Returns null when the message cannot be mapped (e.g. missing required fields).
 */
function buildActivityEnvelope(
  stream: DurableStreamName,
  partition: number,
  offset: string,
  parsed: unknown,
): StreamEnvelope | null {
  const ev = parsed as Partial<ActivityEvent>;
  const activity = ev.activity as Partial<{ id: string; type: string }> | undefined;
  if (!activity?.id) return null;

  const tsMs =
    typeof ev.streamTimestamp === "number"
      ? ev.streamTimestamp
      : typeof ev.receivedAt === "number"
        ? ev.receivedAt
        : typeof ev.publishedAt === "number"
          ? ev.publishedAt
          : Date.now();

  return {
    stream,
    eventId: activity.id,
    cursor: encodeCursor(partition, offset),
    occurredAt: new Date(tsMs).toISOString(),
    schema: "ap.activity.v1",
    payload: parsed,
  };
}

function buildCanonicalEnvelope(
  partition: number,
  offset: string,
  parsed: unknown,
): StreamEnvelope | null {
  const ev = parsed as Partial<CanonicalV1Event>;
  if (!ev.canonicalIntentId || !ev.createdAt) return null;

  return {
    stream: "canonical",
    eventId: ev.canonicalIntentId,
    cursor: encodeCursor(partition, offset),
    occurredAt: ev.createdAt,
    schema: "canonical.intent.v1",
    payload: parsed,
  };
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class FeedStreamKafkaConsumer {
  private readonly consumer: Consumer;
  private readonly service: DurableStreamSubscriptionService;
  /** Maps each subscribed topic to the DurableStreamName it represents. */
  private readonly topicToStream: ReadonlyMap<string, DurableStreamName>;
  private readonly groupId: string;
  private running = false;

  constructor(
    options: FeedStreamKafkaConsumerOptions,
    service: DurableStreamSubscriptionService,
  ) {
    this.service = service;
    this.groupId = options.groupId;

    const kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    this.consumer = kafka.consumer({
      groupId: options.groupId,
      // Avoid unnecessary rebalances under high load
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
    });

    const enabled: ReadonlyArray<DurableStreamName> =
      options.enabledStreams ?? ["stream1", "stream2", "canonical"];

    const topicToStream = new Map<string, DurableStreamName>();
    if (enabled.includes("stream1")) topicToStream.set(options.stream1Topic, "stream1");
    if (enabled.includes("stream2")) topicToStream.set(options.stream2Topic, "stream2");
    if (enabled.includes("canonical")) topicToStream.set(options.canonicalTopic, "canonical");
    if (enabled.includes("firehose")) topicToStream.set(options.firehoseTopic, "firehose");

    this.topicToStream = topicToStream;
  }

  /**
   * Connect to the Kafka broker and begin consuming.
   * Non-blocking — errors are logged, not thrown, so the server
   * can start even if Redpanda is momentarily unavailable.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.consumer.connect();

    for (const topic of this.topicToStream.keys()) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const stream = this.topicToStream.get(topic);
        if (!stream) return;

        const rawValue = message.value?.toString("utf8");
        if (!rawValue) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawValue);
        } catch {
          logger.warn("FeedStreamKafkaConsumer: invalid JSON in message", {
            topic,
            partition,
            offset: message.offset,
          });
          return;
        }

        const envelope =
          stream === "canonical"
            ? buildCanonicalEnvelope(partition, message.offset, parsed)
            : buildActivityEnvelope(stream, partition, message.offset, parsed);

        if (envelope) {
          this.service.publish(envelope);
        }
      },
    });

    logger.info("FeedStreamKafkaConsumer started", {
      groupId: this.groupId,
      topics: [...this.topicToStream.keys()],
      streams: [...this.topicToStream.values()],
    });
  }

  /** Gracefully disconnect from the broker. */
  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      await this.consumer.disconnect();
      logger.info("FeedStreamKafkaConsumer stopped");
    } catch (err) {
      logger.warn("FeedStreamKafkaConsumer: error during shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
