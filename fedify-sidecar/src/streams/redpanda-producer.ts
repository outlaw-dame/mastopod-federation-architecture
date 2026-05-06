/**
 * RedPanda Producer for Activity Streams
 * 
 * Publishes activities to RedPanda topics for event logging.
 * NOT a work queue - these are immutable event logs.
 * 
 * Topics:
 * - ap.stream1.local-public.v1 (Stream1) - Local public activities
 * - ap.stream2.remote-public.v1 (Stream2) - Remote public activities
 * - ap.firehose.v1 - Combined Stream1 + Stream2
 * - ap.tombstones.v1 - Delete activities (compacted)
 */

import { createHash } from "node:crypto";
import { Kafka, Producer, CompressionTypes, logLevel } from "kafkajs";
import { logger } from "../utils/logger.js";
import type { PublicSearchConsentSignal } from "../utils/searchConsent.js";

// ============================================================================
// Types
// ============================================================================

export interface RedPandaConfig {
  brokers: string[];
  clientId: string;
  connectionTimeout: number;
  requestTimeout: number;
  
  // Topic names
  stream1Topic: string;  // Local public activities
  stream2Topic: string;  // Remote public activities
  firehoseTopic: string; // Combined
  tombstoneTopic: string; // Deletes (compacted)
  
  // Producer settings
  compressionType: CompressionTypes;
  batchSize: number;
  lingerMs: number;
}

export interface ActivityEventMeta {
  isPublicActivity?: boolean;
  isPublicIndexable?: boolean;
  isDeleteOrTombstone?: boolean;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "local";
  searchConsent?: PublicSearchConsentSignal;
  /** Hashtags extracted from the object content — pre-parsed to avoid re-HTML-parsing downstream. */
  hashtags?: string[];
}

/**
 * Delivery-forwarding metadata attached to Stream2 (remote-public) events.
 *
 * Consumers use this to distinguish activities that were forwarded to local
 * ActivityPods inboxes ("attempted") from those that bypassed inbox delivery
 * because they target a sidecar-owned service actor ("bypassed"). "skipped"
 * is reserved for future use (e.g. rate-limited or policy-filtered paths).
 *
 * recipientCount    — total unique addressees in to/cc/bto/bcc (excl. Public).
 * localRecipientCount — subset whose hostname matches config.domain.
 */
export interface DeliveryMeta {
  forwarding: "attempted" | "skipped" | "bypassed";
  recipientCount: number;
  localRecipientCount: number;
}

export interface ActivityEvent {
  activity: any;
  actorUri: string;
  receivedAt?: number;
  publishedAt?: number;
  path?: string;
  origin?: "local" | "remote";
  /** Outbox-emitter metadata forwarded verbatim for downstream consumers. */
  meta?: ActivityEventMeta;
  /** Durable local outbox intent identifier for downstream dedupe/replay diagnostics. */
  outboxIntentId?: string;
  streamTimestamp?: number;
  /** Delivery forwarding metadata (Stream2 only). Absent on Stream1 events. */
  delivery?: DeliveryMeta;
}

export interface TombstoneEvent {
  activityId: string;
  objectId?: string;
  actorUri: string;
  deletedAt: number;
  outboxIntentId?: string;
  streamTimestamp?: number;
}

// ============================================================================
// RedPanda Producer
// ============================================================================

export class RedPandaProducer {
  private kafka: Kafka;
  private producer: Producer;
  private config: RedPandaConfig;
  private isConnected = false;

  constructor(config: RedPandaConfig) {
    this.config = config;
    
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      connectionTimeout: config.connectionTimeout,
      requestTimeout: config.requestTimeout,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });
    
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
    });
  }

  /**
   * Connect to RedPanda
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;
    
    await this.producer.connect();
    this.isConnected = true;
    
    logger.info("RedPanda producer connected", { 
      brokers: this.config.brokers,
      clientId: this.config.clientId,
    });
  }

  /**
   * Disconnect from RedPanda
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    
    await this.producer.disconnect();
    this.isConnected = false;
    
    logger.info("RedPanda producer disconnected");
  }

  /**
   * Publish a local public activity to Stream1
   */
  async publishToStream1(event: ActivityEvent): Promise<void> {
    const activity = event.activity;
    const key = this.extractKey(activity);
    const timestamp = event.publishedAt || Date.now();
    
    const message = {
      key,
      value: JSON.stringify({
        ...event,
        origin: "local",
        streamTimestamp: timestamp,
        // meta carries searchConsent and hashtags — keep it for downstream
        // consumers (OpenSearch indexer, protocol bridge) so they don't need
        // to re-parse the activity body.
        meta: event.meta,
      }),
      timestamp: timestamp.toString(),
      headers: {
        "activity-type": activity.type || "Unknown",
        "actor-uri": event.actorUri,
        "origin": "local",
        // Surface consent signal in the Kafka header so consumers can filter
        // before deserialising the full JSON body.
        "search-consent": event.meta?.searchConsent?.isPublic ? "public" : "restricted",
        ...(event.outboxIntentId ? { "outbox-intent-id": event.outboxIntentId } : {}),
      },
    };

    // Publish to Stream1 and Firehose atomically via a single send call to
    // avoid partial writes if the broker rejects one of the two topics.
    await this.producer.sendBatch({
      topicMessages: [
        { topic: this.config.stream1Topic, messages: [message] },
        { topic: this.config.firehoseTopic, messages: [message] },
      ],
      compression: this.config.compressionType,
      acks: -1,  // all ISR replicas must ack — guarantees durability
    });

    logger.debug("Published to Stream1", {
      activityId: activity.id,
      type: activity.type,
      key,
    });
  }

  /**
   * Publish a remote public activity to Stream2
   */
  async publishToStream2(event: ActivityEvent): Promise<void> {
    const activity = event.activity;
    const key = this.extractKey(activity);
    const timestamp = event.receivedAt || Date.now();
    
    const message = {
      key,
      value: JSON.stringify({
        ...event,
        origin: "remote",
        streamTimestamp: timestamp,
        meta: event.meta,
      }),
      timestamp: timestamp.toString(),
      headers: {
        "activity-type": activity.type || "Unknown",
        "actor-uri": event.actorUri,
        "origin": "remote",
        "search-consent": event.meta?.searchConsent?.isPublic ? "public" : "restricted",
        // Allow consumers to filter by forwarding disposition before
        // deserialising the full JSON body.
        "delivery-forwarding": event.delivery?.forwarding ?? "attempted",
        ...(event.outboxIntentId ? { "outbox-intent-id": event.outboxIntentId } : {}),
      },
    };

    await this.producer.sendBatch({
      topicMessages: [
        { topic: this.config.stream2Topic, messages: [message] },
        { topic: this.config.firehoseTopic, messages: [message] },
      ],
      compression: this.config.compressionType,
      acks: -1,
    });

    logger.debug("Published to Stream2", {
      activityId: activity.id,
      type: activity.type,
      key,
    });
  }

  /**
   * Publish a tombstone (delete) event
   */
  async publishTombstone(event: TombstoneEvent): Promise<void> {
    const key = event.objectId || event.activityId;
    
    await this.producer.send({
      topic: this.config.tombstoneTopic,
      compression: this.config.compressionType,
      messages: [{
        key,
        value: JSON.stringify(event),
        timestamp: event.deletedAt.toString(),
        headers: {
          "actor-uri": event.actorUri,
          ...(event.outboxIntentId ? { "outbox-intent-id": event.outboxIntentId } : {}),
        },
      }],
    });

    logger.debug("Published tombstone", { 
      activityId: event.activityId, 
      objectId: event.objectId,
    });
  }

  /**
   * Publish a batch of activities to Stream1
   */
  async publishBatchToStream1(events: ActivityEvent[]): Promise<void> {
    if (events.length === 0) return;

    const messages = events.map(event => {
      const activity = event.activity;
      const timestamp = event.publishedAt || Date.now();
      return {
        key: this.extractKey(activity),
        value: JSON.stringify({
          ...event,
          origin: "local",
          streamTimestamp: timestamp,
          meta: event.meta,
        }),
        timestamp: timestamp.toString(),
        headers: {
          "activity-type": activity.type || "Unknown",
          "actor-uri": event.actorUri,
          "origin": "local",
          "search-consent": event.meta?.searchConsent?.isPublic ? "public" : "restricted",
          ...(event.outboxIntentId ? { "outbox-intent-id": event.outboxIntentId } : {}),
        },
      };
    });

    await this.producer.sendBatch({
      topicMessages: [
        { topic: this.config.stream1Topic, messages },
        { topic: this.config.firehoseTopic, messages },
      ],
      compression: this.config.compressionType,
      acks: -1,
    });

    logger.debug("Published batch to Stream1", { count: events.length });
  }

  /**
   * Extract a partition key from an activity.
   *
   * For Announce (boost) activities the key is sha256(actorUri + "::" + objectId).
   * This routes all boosts of the same object by the same actor to the same
   * partition so that stream consumers can aggregate and deduplicate by key
   * without deserialising the full message body (stream-as-aggregator pattern).
   *
   * For all other types the key is the actor URI, which preserves per-actor
   * partition locality and ordering guarantees.
   */
  private extractKey(activity: any): string {
    if (activity.type === "Announce") {
      const objectUri =
        typeof activity.object === "string"
          ? activity.object
          : typeof activity.object?.id === "string"
            ? activity.object.id
            : null;
      if (objectUri) {
        const actorUri =
          typeof activity.actor === "string"
            ? activity.actor
            : typeof activity.actor?.id === "string"
              ? activity.actor.id
              : null;
        if (actorUri) {
          return createHash("sha256")
            .update(actorUri)
            .update("::")
            .update(objectUri)
            .digest("hex");
        }
      }
    }

    // Default: key by actor URI for per-actor partition locality.
    if (activity.actor) {
      const actor = typeof activity.actor === "string" ? activity.actor : activity.actor?.id;
      if (actor) return actor;
    }

    if (activity.id) return activity.id;

    return `unknown-${Date.now()}`;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createRedPandaProducer(overrides?: Partial<RedPandaConfig>): RedPandaProducer {
  const compressionEnv = (process.env["REDPANDA_COMPRESSION"] || "gzip").toLowerCase();
  const compressionType = (() => {
    switch (compressionEnv) {
      case "gzip":
        return CompressionTypes.GZIP;
      case "snappy":
        return CompressionTypes.Snappy;
      case "lz4":
        return CompressionTypes.LZ4;
      case "zstd":
        return CompressionTypes.ZSTD;
      default:
        return CompressionTypes.GZIP;
    }
  })();

  const config: RedPandaConfig = {
    brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092").split(","),
    clientId: process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar",
    connectionTimeout: parseInt(process.env["REDPANDA_CONNECTION_TIMEOUT"] || "10000", 10),
    requestTimeout: parseInt(process.env["REDPANDA_REQUEST_TIMEOUT"] || "30000", 10),
    // STREAM1_TOPIC is the canonical env var shared with the protocol-bridge
    // consumer (protocolBridgeApSourceTopic in config).  REDPANDA_STREAM1_TOPIC
    // is an alias kept for backwards-compat — prefer the shared name.
    stream1Topic: process.env["STREAM1_TOPIC"] || process.env["REDPANDA_STREAM1_TOPIC"] || "ap.stream1.local-public.v1",
    stream2Topic: process.env["STREAM2_TOPIC"] || process.env["REDPANDA_STREAM2_TOPIC"] || "ap.stream2.remote-public.v1",
    firehoseTopic: process.env["FIREHOSE_TOPIC"] || process.env["REDPANDA_FIREHOSE_TOPIC"] || "ap.firehose.v1",
    tombstoneTopic: process.env["TOMBSTONE_TOPIC"] || process.env["REDPANDA_TOMBSTONE_TOPIC"] || "ap.tombstones.v1",
    compressionType,
    batchSize: parseInt(process.env["REDPANDA_BATCH_SIZE"] || "16384", 10),
    lingerMs: parseInt(process.env["REDPANDA_LINGER_MS"] || "5", 10),
    ...overrides,
  };

  return new RedPandaProducer(config);
}

// ============================================================================
// Topic Configuration (for admin setup)
// ============================================================================

export const TOPIC_CONFIGS = {
  // Stream1: Local public activities
  [process.env["STREAM1_TOPIC"] || process.env["REDPANDA_STREAM1_TOPIC"] || "ap.stream1.local-public.v1"]: {
    numPartitions: 12,
    replicationFactor: 3,
    configEntries: [
      { name: "retention.ms", value: "604800000" },  // 7 days
      { name: "cleanup.policy", value: "delete" },
      { name: "compression.type", value: "zstd" },
    ],
  },
  
  // Stream2: Remote public activities
  [process.env["STREAM2_TOPIC"] || process.env["REDPANDA_STREAM2_TOPIC"] || "ap.stream2.remote-public.v1"]: {
    numPartitions: 12,
    replicationFactor: 3,
    configEntries: [
      { name: "retention.ms", value: "604800000" },  // 7 days
      { name: "cleanup.policy", value: "delete" },
      { name: "compression.type", value: "zstd" },
    ],
  },
  
  // Firehose: Combined Stream1 + Stream2
  [process.env["FIREHOSE_TOPIC"] || process.env["REDPANDA_FIREHOSE_TOPIC"] || "ap.firehose.v1"]: {
    numPartitions: 24,
    replicationFactor: 3,
    configEntries: [
      { name: "retention.ms", value: "604800000" },  // 7 days
      { name: "cleanup.policy", value: "delete" },
      { name: "compression.type", value: "zstd" },
    ],
  },
  
  // Tombstones: Delete events (compacted)
  [process.env["TOMBSTONE_TOPIC"] || process.env["REDPANDA_TOMBSTONE_TOPIC"] || "ap.tombstones.v1"]: {
    numPartitions: 6,
    replicationFactor: 3,
    configEntries: [
      { name: "cleanup.policy", value: "compact" },
      { name: "compression.type", value: "zstd" },
      { name: "min.cleanable.dirty.ratio", value: "0.5" },
      { name: "delete.retention.ms", value: "86400000" },  // 1 day
    ],
  },
};
