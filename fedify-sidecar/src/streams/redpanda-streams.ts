/**
 * RedPanda Streams Module
 *
 * RedPanda is used as the streaming backbone for public activities (logs),
 * NOT as Fedify's work queue.
 */

import { Kafka, Producer, Consumer, EachMessagePayload, type CompressionTypes } from "kafkajs";
import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import { ensureRedpandaCompressionCodec } from "./kafka-compression.js";

export interface RedPandaConfig {
  brokers: string[];
  clientId: string;
  localPublicTopic: string;
  remotePublicTopic: string;
  firehoseTopic: string;
  tombstoneTopic: string;
  consumerGroupId: string;
  compressionType: CompressionTypes;
}

export interface LocalPublicActivity {
  schema: "ap.outbox.committed.v1";
  eventId: string;
  timestamp: string;
  actorUri: string;
  podDataset?: string;
  activityId: string;
  objectId: string;
  activityType: string;
  activity: Record<string, unknown>;
  deliveryTargets: Array<{
    recipientHost: string;
    inboxUrl: string;
    sharedInboxUrl?: string;
  }>;
  meta: {
    isPublicIndexable: boolean;
    isDeleteOrTombstone: boolean;
    visibility: "public" | "unlisted" | "followers" | "direct";
  };
}

export interface RemotePublicActivity {
  schema: "ap.inbound.accepted.v1";
  eventId: string;
  timestamp: string;
  originDomain: string;
  originActorUri: string;
  activityId: string;
  objectId?: string;
  activityType: string;
  activity: Record<string, unknown>;
  verification: {
    signatureVerified: boolean;
    keyId: string;
    verifiedAt: string;
  };
  meta: {
    isPublicIndexable: boolean;
  };
}

export interface TombstoneEvent {
  schema: "ap.tombstone.v1";
  eventId: string;
  timestamp: string;
  objectId: string;
  objectType?: string;
  actorUri: string;
  activityId: string;
  activityType: "Delete" | "Undo";
  activity: Record<string, unknown>;
  origin: "local" | "remote";
  originDomain?: string;
}

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

  async produceLocalPublic(activity: LocalPublicActivity): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    await this.producer.send({
      topic: this.config.localPublicTopic,
      compression: this.config.compressionType,
      messages: [
        {
          key: this.partitionKey(activity.actorUri),
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

  async produceRemotePublic(activity: RemotePublicActivity): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    await this.producer.send({
      topic: this.config.remotePublicTopic,
      compression: this.config.compressionType,
      messages: [
        {
          key: this.partitionKey(activity.originDomain),
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

  async produceFirehose(activity: LocalPublicActivity | RemotePublicActivity): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    const key = activity.schema === "ap.outbox.committed.v1"
      ? this.partitionKey(activity.actorUri)
      : this.partitionKey(activity.originDomain);

    await this.producer.send({
      topic: this.config.firehoseTopic,
      compression: this.config.compressionType,
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
  }

  async produceTombstone(tombstone: TombstoneEvent): Promise<void> {
    if (!this.producer) throw new Error("Producer not connected");

    await this.producer.send({
      topic: this.config.tombstoneTopic,
      compression: this.config.compressionType,
      messages: [
        {
          key: this.partitionKey(tombstone.objectId),
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
          await handler(JSON.parse(message.value.toString()));
        } catch (err: any) {
          logger.error("Error processing firehose message", { error: err.message });
        }
      },
    });

    logger.info("Firehose consumer started", {
      topic: this.config.firehoseTopic,
    });
  }

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
          await handler(JSON.parse(message.value.toString()));
        } catch (err: any) {
          logger.error("Error processing tombstone message", { error: err.message });
        }
      },
    });

    logger.info("Tombstone consumer started", {
      topic: this.config.tombstoneTopic,
    });
  }

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
          await handler(JSON.parse(message.value.toString()));
        } catch (err: any) {
          logger.error("Error processing local public message", { error: err.message });
        }
      },
    });

    logger.info("Local public consumer started", {
      topic: this.config.localPublicTopic,
    });
  }

  private partitionKey(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

export function createRedPandaStreams(config?: Partial<RedPandaConfig>): RedPandaStreams {
  const compressionType = ensureRedpandaCompressionCodec(
    process.env["REDPANDA_COMPRESSION"] ?? "zstd",
  );

  const fullConfig: RedPandaConfig = {
    brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092").split(","),
    clientId: process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar",
    localPublicTopic: process.env["REDPANDA_LOCAL_TOPIC"] || "apub.public.local.v1",
    remotePublicTopic: process.env["REDPANDA_REMOTE_TOPIC"] || "apub.public.remote.v1",
    firehoseTopic: process.env["REDPANDA_FIREHOSE_TOPIC"] || "apub.public.firehose.v1",
    tombstoneTopic: process.env["REDPANDA_TOMBSTONE_TOPIC"] || "apub.tombstone.v1",
    consumerGroupId: process.env["REDPANDA_CONSUMER_GROUP"] || "fedify-sidecar",
    compressionType,
    ...config,
  };

  return new RedPandaStreams(fullConfig);
}

/**
 * RedPanda topic creation commands (run via rpk):
 *
 * rpk topic create apub.public.local.v1 --partitions 12 --config retention.ms=604800000 --config cleanup.policy=delete --config compression.type=producer
 * rpk topic create apub.public.remote.v1 --partitions 12 --config retention.ms=604800000 --config cleanup.policy=delete --config compression.type=producer
 * rpk topic create apub.public.firehose.v1 --partitions 24 --config retention.ms=2592000000 --config cleanup.policy=delete --config compression.type=producer
 * rpk topic create apub.tombstone.v1 --partitions 12 --config retention.ms=7776000000 --config cleanup.policy=compact,delete --config compression.type=producer
 */