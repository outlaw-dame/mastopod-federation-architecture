/**
 * Streams Service
 * 
 * Manages the three core streams:
 * - Stream1: Local public activities (from pod outboxes)
 * - Stream2: Remote public activities (from Fedify inbox)
 * - Firehose: Combined Stream1 + Stream2
 * 
 * All streams are backed by RedPanda topics.
 */

import { Kafka, Producer, Consumer, EachMessagePayload, CompressionTypes } from "kafkajs";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import { metrics } from "../metrics/index.js";
import { OpenSearchService } from "../services/opensearch.js";

// Stream topic names
export const STREAM_TOPICS = {
  STREAM1_LOCAL: "stream1-local-public",
  STREAM2_REMOTE: "stream2-remote-public",
  FIREHOSE: "firehose",
} as const;

export type StreamTopic = typeof STREAM_TOPICS[keyof typeof STREAM_TOPICS];

// Activity envelope for streams
export interface StreamActivity {
  id: string;
  type: string;
  actor: string;
  actorDomain: string;
  object?: unknown;
  published: string;
  receivedAt: number;
  origin: "local" | "remote";
  visibility: "public" | "unlisted" | "followers" | "direct";
  raw: unknown;
}

/**
 * Streams Service
 * Handles publishing and consuming from Stream1, Stream2, and Firehose
 */
export class StreamsService {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private consumers = new Map<string, Consumer>();
  private isInitialized = false;
  private openSearchService: OpenSearchService | null = null;

  constructor() {
    this.kafka = new Kafka({
      clientId: config.redpanda.clientId + "-streams",
      brokers: config.redpanda.brokers.split(","),
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });
  }

  /**
   * Initialize the streams service
   */
  async initialize(openSearchService?: OpenSearchService): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    logger.info("Initializing streams service...");

    this.openSearchService = openSearchService ?? null;

    // Create producer
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
    });
    await this.producer.connect();

    // Ensure topics exist
    const admin = this.kafka.admin();
    await admin.connect();

    const existingTopics = await admin.listTopics();
    const requiredTopics = Object.values(STREAM_TOPICS);
    const missingTopics = requiredTopics.filter(t => !existingTopics.includes(t));

    if (missingTopics.length > 0) {
      await admin.createTopics({
        topics: missingTopics.map(topic => ({
          topic,
          numPartitions: 8,
          replicationFactor: 1,
          configEntries: [
            { name: "retention.ms", value: "604800000" }, // 7 days
            { name: "cleanup.policy", value: "delete" },
          ],
        })),
      });
      logger.info("Created stream topics", { topics: missingTopics });
    }

    await admin.disconnect();

    this.isInitialized = true;
    logger.info("Streams service initialized");
  }

  /**
   * Publish to Stream1 (local public activities)
   */
  async publishToStream1(activity: StreamActivity): Promise<void> {
    await this.publish(STREAM_TOPICS.STREAM1_LOCAL, activity);
    
    // Also publish to Firehose
    await this.publish(STREAM_TOPICS.FIREHOSE, activity);
  }

  /**
   * Publish to Stream2 (remote public activities)
   */
  async publishToStream2(activity: StreamActivity): Promise<void> {
    await this.publish(STREAM_TOPICS.STREAM2_REMOTE, activity);
    
    // Also publish to Firehose
    await this.publish(STREAM_TOPICS.FIREHOSE, activity);
  }

  /**
   * Publish activity to a stream topic
   */
  private async publish(topic: StreamTopic, activity: StreamActivity): Promise<void> {
    if (!this.producer) {
      throw new Error("Streams service not initialized");
    }

    try {
      await this.producer.send({
        topic,
        compression: CompressionTypes.Snappy,
        messages: [{
          key: activity.actorDomain, // Partition by actor domain
          value: JSON.stringify(activity),
          headers: {
            "x-activity-type": activity.type,
            "x-origin": activity.origin,
            "x-published": activity.published,
          },
        }],
      });

      metrics.streamMessagesPublished.inc({ stream: topic });

      logger.debug("Published to stream", {
        topic,
        activityId: activity.id,
        type: activity.type,
      });
    } catch (error) {
      logger.error("Failed to publish to stream", { topic, error });
      throw error;
    }
  }

  /**
   * Start consuming from Firehose and indexing to OpenSearch
   */
  async startFirehoseConsumer(): Promise<void> {
    if (!this.openSearchService) {
      logger.warn("OpenSearch service not configured, skipping Firehose consumer");
      return;
    }

    logger.info("Starting Firehose consumer for OpenSearch indexing...");

    const consumer = this.kafka.consumer({
      groupId: config.redpanda.clientId + "-firehose-opensearch",
      sessionTimeout: 30000,
    });

    await consumer.connect();
    await consumer.subscribe({
      topic: STREAM_TOPICS.FIREHOSE,
      fromBeginning: false,
    });

    this.consumers.set(STREAM_TOPICS.FIREHOSE, consumer);

    // Batch activities for bulk indexing
    let batch: StreamActivity[] = [];
    let batchTimeout: NodeJS.Timeout | null = null;
    const BATCH_SIZE = 100;
    const BATCH_TIMEOUT_MS = 1000;

    const flushBatch = async () => {
      if (batch.length === 0) {
        return;
      }

      const toIndex = [...batch];
      batch = [];

      if (batchTimeout) {
        clearTimeout(batchTimeout);
        batchTimeout = null;
      }

      try {
        await this.openSearchService!.bulkIndexActivities(toIndex);
        metrics.opensearchBulkSize.observe(toIndex.length);
      } catch (error) {
        logger.error("Failed to bulk index activities", { error, count: toIndex.length });
      }
    };

    await consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        if (!payload.message.value) {
          return;
        }

        try {
          const activity: StreamActivity = JSON.parse(payload.message.value.toString());
          batch.push(activity);

          metrics.streamMessagesConsumed.inc({ stream: STREAM_TOPICS.FIREHOSE });

          // Flush if batch is full
          if (batch.length >= BATCH_SIZE) {
            await flushBatch();
          } else if (!batchTimeout) {
            // Set timeout for partial batch
            batchTimeout = setTimeout(flushBatch, BATCH_TIMEOUT_MS);
          }
        } catch (error) {
          logger.error("Failed to process Firehose message", { error });
        }
      },
    });

    logger.info("Firehose consumer started");
  }

  /**
   * Create a StreamActivity from an ActivityPub activity
   */
  static createStreamActivity(
    activity: unknown,
    origin: "local" | "remote"
  ): StreamActivity {
    const act = activity as Record<string, unknown>;
    const actorId = (typeof act.actor === "string" ? act.actor : (act.actor as any)?.id) ?? "";
    
    let actorDomain = "";
    try {
      actorDomain = new URL(actorId).hostname;
    } catch {
      // Ignore invalid URLs
    }

    return {
      id: (act.id ?? act["@id"] ?? "") as string,
      type: (act.type ?? act["@type"] ?? "Unknown") as string,
      actor: actorId,
      actorDomain,
      object: act.object,
      published: (act.published ?? new Date().toISOString()) as string,
      receivedAt: Date.now(),
      origin,
      visibility: this.determineVisibility(act),
      raw: activity,
    };
  }

  /**
   * Determine visibility of an activity
   */
  private static determineVisibility(
    activity: Record<string, unknown>
  ): StreamActivity["visibility"] {
    const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
    const PUBLIC_ALT = "as:Public";

    const to = this.normalizeRecipients(activity.to);
    const cc = this.normalizeRecipients(activity.cc);
    const allRecipients = [...to, ...cc];

    if (to.includes(PUBLIC) || to.includes(PUBLIC_ALT)) {
      return "public";
    }

    if (cc.includes(PUBLIC) || cc.includes(PUBLIC_ALT)) {
      return "unlisted";
    }

    // Check for followers collection
    const hasFollowers = allRecipients.some(r => 
      r.includes("/followers") || r.includes("/following")
    );

    if (hasFollowers) {
      return "followers";
    }

    return "direct";
  }

  /**
   * Normalize recipients to array of strings
   */
  private static normalizeRecipients(recipients: unknown): string[] {
    if (!recipients) {
      return [];
    }

    if (typeof recipients === "string") {
      return [recipients];
    }

    if (Array.isArray(recipients)) {
      return recipients.filter(r => typeof r === "string");
    }

    return [];
  }

  /**
   * Check if an activity is public
   */
  static isPublicActivity(activity: unknown): boolean {
    const visibility = this.createStreamActivity(activity, "local").visibility;
    return visibility === "public" || visibility === "unlisted";
  }

  /**
   * Stop all consumers
   */
  async stop(): Promise<void> {
    logger.info("Stopping streams service...");

    for (const [topic, consumer] of this.consumers) {
      await consumer.disconnect();
      logger.debug("Disconnected consumer", { topic });
    }
    this.consumers.clear();

    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }

    this.isInitialized = false;
    logger.info("Streams service stopped");
  }
}

// Export singleton instance
export const streamsService = new StreamsService();
