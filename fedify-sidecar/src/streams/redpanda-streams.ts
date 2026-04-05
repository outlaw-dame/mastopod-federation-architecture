/**
 * RedPanda Streams Module
 * 
 * RedPanda is used as the streaming backbone for public activities (logs),
 * NOT as Fedify's work queue. This module handles:
 * 
 * - apub.public.local.v1 (Stream1): Public activities from local pods
 * - apub.public.remote.v1 (Stream2): Public activities from remote fediverse
 * - apub.public.firehose.v1: Combined local + remote for indexing
 * - apub.tombstone.v1: Delete/tombstone events for read model updates
 * 
 * Partition keys:
 * - Local: actorUri or podDataset
 * - Remote: originDomain
 * - Tombstone: objectId (for compaction)
 */

import { Kafka, Producer, Consumer, EachMessagePayload, CompressionTypes } from "kafkajs";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { logger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface RedPandaConfig {
  brokers: string[];
  clientId: string;
  
  // Topic names
  localPublicTopic: string;
  remotePublicTopic: string;
  firehoseTopic: string;
  tombstoneTopic: string;
  
  // Consumer settings
  consumerGroupId: string;
}

/**
 * Schema for local public activities (Stream1)
 * Emitted when ActivityPods commits a public activity to outbox
 */
export interface LocalPublicActivity {
  schema: "ap.outbox.committed.v1";
  eventId: string;
  timestamp: string;
  
  // Source
  actorUri: string;
  podDataset?: string;
  
  // Activity
  activityId: string;
  objectId: string;
  activityType: string;
  activity: Record<string, unknown>;
  
  // Delivery targets (resolved by ActivityPods)
  deliveryTargets: Array<{
    recipientHost: string;
    inboxUrl: string;
    sharedInboxUrl?: string;
  }>;
  
  // Metadata
  meta: {
    isPublicIndexable: boolean;
    isDeleteOrTombstone: boolean;
    visibility: "public" | "unlisted" | "followers" | "direct";
  };
}

/**
 * Schema for remote public activities (Stream2)
 * Emitted when sidecar accepts a public activity from remote
 */
export interface RemotePublicActivity {
  schema: "ap.inbound.accepted.v1";
  eventId: string;
  timestamp: string;
  
  // Origin
  originDomain: string;
  originActorUri: string;
  
  // Activity
  activityId: string;
  objectId?: string;
  activityType: string;
  activity: Record<string, unknown>;
  
  // Verification
  verification: {
    signatureVerified: boolean;
    keyId: string;
    verifiedAt: string;
  };
  
  // Metadata
  meta: {
    isPublicIndexable: boolean;
  };
}

/**
 * Schema for tombstone/delete events
 */
export interface TombstoneEvent {
  schema: "ap.tombstone.v1";
  eventId: string;
  timestamp: string;
  
  // Object being deleted
  objectId: string;
  objectType?: string;
  
  // Actor who deleted
  actorUri: string;
  
  // Activity
  activityId: string;
  activityType: "Delete" | "Undo";
  activity: Record<string, unknown>;
  
  // Origin
  origin: "local" | "remote";
  originDomain?: string;
}

// ============================================================================
// RedPanda Streams Implementation
// ============================================================================

export class RedPandaStreams {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private consumers: Map<string, Consumer> = new Map();
  private config: RedPandaConfig;
  private isConnected = false;

  constructor(config: RedPandaConfig) {
    this.config = config;
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
    });
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.isConnected) return;

    this.producer = this.kafka.producer();
    await this.producer.connect();
    this.isConnected = true;

    logger.info("RedPanda producer connected", {
      brokers: this.config.brokers,
    });
  }

  async disconnect(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }

    for (const [name, consumer] of this.consumers) {
      await consumer.disconnect();
      logger.info("Consumer disconnected", { name });
    }
    this.consumers.clear();

    this.isConnected = false;
  }

  // ==========================================================================
  // Producers
  // ==========================================================================

  /**
   * Produce a local public activity to Stream1.
   * Partition key: actorUri (for per-actor ordering)
   */
  async produceLocalPublic(activity: LocalPublicActivity): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    const key = this.partitionKey(activity.actorUri);
    
    await this.producer.send({
      topic: this.config.localPublicTopic,
      compression: CompressionTypes.ZSTD,
      messages: [
        {
          key,
          value: JSON.stringify(activity),
          headers: {
            schema: activity.schema,
            activityType: activity.activityType,
          },
        },
      ],
    });

    logger.debug("Produced local public activity", {
      topic: this.config.localPublicTopic,
      activityId: activity.activityId,
      actorUri: activity.actorUri,
    });
  }

  /**
   * Produce a remote public activity to Stream2.
   * Partition key: originDomain (for per-domain isolation)
   */
  async produceRemotePublic(activity: RemotePublicActivity): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    const key = this.partitionKey(activity.originDomain);
    
    await this.producer.send({
      topic: this.config.remotePublicTopic,
      compression: CompressionTypes.ZSTD,
      messages: [
        {
          key,
          value: JSON.stringify(activity),
          headers: {
            schema: activity.schema,
            activityType: activity.activityType,
            originDomain: activity.originDomain,
          },
        },
      ],
    });

    logger.debug("Produced remote public activity", {
      topic: this.config.remotePublicTopic,
      activityId: activity.activityId,
      originDomain: activity.originDomain,
    });
  }

  /**
   * Produce to the firehose (combined stream).
   * Called by a forwarder that reads local + remote and writes combined.
   */
  async produceFirehose(activity: LocalPublicActivity | RemotePublicActivity): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    // Determine partition key based on activity type
    const key = "schema" in activity && activity.schema === "ap.outbox.committed.v1"
      ? this.partitionKey((activity as LocalPublicActivity).actorUri)
      : this.partitionKey((activity as RemotePublicActivity).originDomain);
    
    await this.producer.send({
      topic: this.config.firehoseTopic,
      compression: CompressionTypes.ZSTD,
      messages: [
        {
          key,
          value: JSON.stringify(activity),
          headers: {
            schema: (activity as any).schema,
            activityType: (activity as any).activityType,
          },
        },
      ],
    });
  }

  /**
   * Produce a tombstone event.
   * Partition key: objectId (for compaction correctness)
   */
  async produceTombstone(tombstone: TombstoneEvent): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    const key = this.partitionKey(tombstone.objectId);
    
    await this.producer.send({
      topic: this.config.tombstoneTopic,
      compression: CompressionTypes.ZSTD,
      messages: [
        {
          key,
          value: JSON.stringify(tombstone),
          headers: {
            schema: tombstone.schema,
            activityType: tombstone.activityType,
          },
        },
      ],
    });

    logger.debug("Produced tombstone event", {
      topic: this.config.tombstoneTopic,
      objectId: tombstone.objectId,
      activityType: tombstone.activityType,
    });
  }

  // ==========================================================================
  // Consumers
  // ==========================================================================

  /**
   * Create a consumer for the firehose (for OpenSearch indexing).
   */
  async consumeFirehose(
    handler: (activity: LocalPublicActivity | RemotePublicActivity) => Promise<void>
  ): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId: `${this.config.consumerGroupId}-firehose`,
    });

    await consumer.connect();
    await consumer.subscribe({
      topic: this.config.firehoseTopic,
      fromBeginning: false,
    });

    this.consumers.set("firehose", consumer);

    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        if (!message.value) return;
        
        try {
          const activity = JSON.parse(message.value.toString());
          await handler(activity);
        } catch (err: any) {
          logger.error("Error processing firehose message", { error: err.message });
        }
      },
    });

    logger.info("Firehose consumer started", {
      topic: this.config.firehoseTopic,
    });
  }

  /**
   * Create a consumer for tombstones (for OpenSearch deletion).
   */
  async consumeTombstones(
    handler: (tombstone: TombstoneEvent) => Promise<void>
  ): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId: `${this.config.consumerGroupId}-tombstones`,
    });

    await consumer.connect();
    await consumer.subscribe({
      topic: this.config.tombstoneTopic,
      fromBeginning: false,
    });

    this.consumers.set("tombstones", consumer);

    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        if (!message.value) return;
        
        try {
          const tombstone = JSON.parse(message.value.toString());
          await handler(tombstone);
        } catch (err: any) {
          logger.error("Error processing tombstone message", { error: err.message });
        }
      },
    });

    logger.info("Tombstone consumer started", {
      topic: this.config.tombstoneTopic,
    });
  }

  /**
   * Create a consumer for local public activities (for delivery fanout).
   */
  async consumeLocalPublic(
    handler: (activity: LocalPublicActivity) => Promise<void>
  ): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId: `${this.config.consumerGroupId}-local`,
    });

    await consumer.connect();
    await consumer.subscribe({
      topic: this.config.localPublicTopic,
      fromBeginning: false,
    });

    this.consumers.set("local", consumer);

    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        if (!message.value) return;
        
        try {
          const activity = JSON.parse(message.value.toString());
          await handler(activity);
        } catch (err: any) {
          logger.error("Error processing local public message", { error: err.message });
        }
      },
    });

    logger.info("Local public consumer started", {
      topic: this.config.localPublicTopic,
    });
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Generate partition key (SHA256 hash for even distribution).
   */
  private partitionKey(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRedPandaStreams(config?: Partial<RedPandaConfig>): RedPandaStreams {
  const fullConfig: RedPandaConfig = {
    brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092").split(","),
    clientId: process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar",
    localPublicTopic: process.env["REDPANDA_LOCAL_TOPIC"] || "apub.public.local.v1",
    remotePublicTopic: process.env["REDPANDA_REMOTE_TOPIC"] || "apub.public.remote.v1",
    firehoseTopic: process.env["REDPANDA_FIREHOSE_TOPIC"] || "apub.public.firehose.v1",
    tombstoneTopic: process.env["REDPANDA_TOMBSTONE_TOPIC"] || "apub.tombstone.v1",
    consumerGroupId: process.env["REDPANDA_CONSUMER_GROUP"] || "fedify-sidecar",
    ...config,
  };

  return new RedPandaStreams(fullConfig);
}

// ============================================================================
// Topic Creation Commands (for reference)
// ============================================================================

/**
 * RedPanda topic creation commands (run via rpk):
 * 
 * # Local public activities (Stream1)
 * rpk topic create apub.public.local.v1 \
 *   --partitions 12 \
 *   --config retention.ms=604800000 \
 *   --config cleanup.policy=delete
 * 
 * # Remote public activities (Stream2)
 * rpk topic create apub.public.remote.v1 \
 *   --partitions 12 \
 *   --config retention.ms=604800000 \
 *   --config cleanup.policy=delete
 * 
 * # Firehose (combined for indexing)
 * rpk topic create apub.public.firehose.v1 \
 *   --partitions 24 \
 *   --config retention.ms=2592000000 \
 *   --config cleanup.policy=delete
 * 
 * # Tombstones (with compaction for latest state)
 * rpk topic create apub.tombstone.v1 \
 *   --partitions 12 \
 *   --config retention.ms=7776000000 \
 *   --config cleanup.policy=compact,delete
 */
