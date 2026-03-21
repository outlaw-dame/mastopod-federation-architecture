/**
 * RedPanda Producer for Activity Streams
 * 
 * Publishes activities to RedPanda topics for event logging.
 * NOT a work queue - these are immutable event logs.
 * 
 * Topics:
 * - apub.public.local.v1 (Stream1) - Local public activities
 * - apub.public.remote.v1 (Stream2) - Remote public activities
 * - apub.public.firehose.v1 - Combined Stream1 + Stream2
 * - apub.tombstone.v1 - Delete activities (compacted)
 */

import { Kafka, Producer, CompressionTypes, logLevel } from "kafkajs";
import { logger } from "../utils/logger.js";

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

export interface ActivityEvent {
  activity: any;
  actorUri: string;
  receivedAt?: number;
  publishedAt?: number;
  path?: string;
  origin?: "local" | "remote";
}

export interface TombstoneEvent {
  activityId: string;
  objectId?: string;
  actorUri: string;
  deletedAt: number;
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
      allowAutoTopicCreation: true,
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
      }),
      timestamp: timestamp.toString(),
      headers: {
        "activity-type": activity.type || "Unknown",
        "actor-uri": event.actorUri,
        "origin": "local",
      },
    };

    // Publish to Stream1
    await this.producer.send({
      topic: this.config.stream1Topic,
      compression: this.config.compressionType,
      messages: [message],
    });

    // Also publish to Firehose
    await this.producer.send({
      topic: this.config.firehoseTopic,
      compression: this.config.compressionType,
      messages: [message],
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
      }),
      timestamp: timestamp.toString(),
      headers: {
        "activity-type": activity.type || "Unknown",
        "actor-uri": event.actorUri,
        "origin": "remote",
      },
    };

    // Publish to Stream2
    await this.producer.send({
      topic: this.config.stream2Topic,
      compression: this.config.compressionType,
      messages: [message],
    });

    // Also publish to Firehose
    await this.producer.send({
      topic: this.config.firehoseTopic,
      compression: this.config.compressionType,
      messages: [message],
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
        }),
        timestamp: timestamp.toString(),
        headers: {
          "activity-type": activity.type || "Unknown",
          "actor-uri": event.actorUri,
          "origin": "local",
        },
      };
    });

    // Publish to Stream1
    await this.producer.send({
      topic: this.config.stream1Topic,
      compression: this.config.compressionType,
      messages,
    });

    // Also publish to Firehose
    await this.producer.send({
      topic: this.config.firehoseTopic,
      compression: this.config.compressionType,
      messages,
    });

    logger.debug("Published batch to Stream1", { count: events.length });
  }

  /**
   * Extract a partition key from an activity
   * Uses actor URI for locality (activities from same actor go to same partition)
   */
  private extractKey(activity: any): string {
    // Prefer actor URI for partitioning
    if (activity.actor) {
      const actor = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
      if (actor) return actor;
    }
    
    // Fall back to activity ID
    if (activity.id) return activity.id;
    
    // Last resort: random key
    return `unknown-${Date.now()}`;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createRedPandaProducer(overrides?: Partial<RedPandaConfig>): RedPandaProducer {
  const config: RedPandaConfig = {
    brokers: (process.env.REDPANDA_BROKERS || "localhost:9092").split(","),
    clientId: process.env.REDPANDA_CLIENT_ID || "fedify-sidecar",
    connectionTimeout: parseInt(process.env.REDPANDA_CONNECTION_TIMEOUT || "10000", 10),
    requestTimeout: parseInt(process.env.REDPANDA_REQUEST_TIMEOUT || "30000", 10),
    stream1Topic: process.env.REDPANDA_STREAM1_TOPIC || "apub.public.local.v1",
    stream2Topic: process.env.REDPANDA_STREAM2_TOPIC || "apub.public.remote.v1",
    firehoseTopic: process.env.REDPANDA_FIREHOSE_TOPIC || "apub.public.firehose.v1",
    tombstoneTopic: process.env.REDPANDA_TOMBSTONE_TOPIC || "apub.tombstone.v1",
    compressionType: CompressionTypes.Snappy,
    batchSize: parseInt(process.env.REDPANDA_BATCH_SIZE || "16384", 10),
    lingerMs: parseInt(process.env.REDPANDA_LINGER_MS || "5", 10),
    ...overrides,
  };

  return new RedPandaProducer(config);
}

// ============================================================================
// Topic Configuration (for admin setup)
// ============================================================================

export const TOPIC_CONFIGS = {
  // Stream1: Local public activities
  [process.env.REDPANDA_STREAM1_TOPIC || "apub.public.local.v1"]: {
    numPartitions: 12,
    replicationFactor: 3,
    configEntries: [
      { name: "retention.ms", value: "604800000" },  // 7 days
      { name: "cleanup.policy", value: "delete" },
      { name: "compression.type", value: "snappy" },
    ],
  },
  
  // Stream2: Remote public activities
  [process.env.REDPANDA_STREAM2_TOPIC || "apub.public.remote.v1"]: {
    numPartitions: 12,
    replicationFactor: 3,
    configEntries: [
      { name: "retention.ms", value: "604800000" },  // 7 days
      { name: "cleanup.policy", value: "delete" },
      { name: "compression.type", value: "snappy" },
    ],
  },
  
  // Firehose: Combined Stream1 + Stream2
  [process.env.REDPANDA_FIREHOSE_TOPIC || "apub.public.firehose.v1"]: {
    numPartitions: 24,
    replicationFactor: 3,
    configEntries: [
      { name: "retention.ms", value: "604800000" },  // 7 days
      { name: "cleanup.policy", value: "delete" },
      { name: "compression.type", value: "snappy" },
    ],
  },
  
  // Tombstones: Delete events (compacted)
  [process.env.REDPANDA_TOMBSTONE_TOPIC || "apub.tombstone.v1"]: {
    numPartitions: 6,
    replicationFactor: 3,
    configEntries: [
      { name: "cleanup.policy", value: "compact" },
      { name: "compression.type", value: "snappy" },
      { name: "min.cleanable.dirty.ratio", value: "0.5" },
      { name: "delete.retention.ms", value: "86400000" },  // 1 day
    ],
  },
};
