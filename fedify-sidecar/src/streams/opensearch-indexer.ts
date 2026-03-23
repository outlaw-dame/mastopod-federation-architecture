/**
 * OpenSearch Indexer
 * 
 * Consumes from the Firehose topic and indexes activities into OpenSearch.
 * This provides queryable storage for all public activities.
 * 
 * Key features:
 * - Bulk indexing for efficiency
 * - Handles tombstones (deletes)
 * - Maintains activity metadata for queries
 */

import { Client } from "@opensearch-project/opensearch";
import { Kafka, Consumer, EachBatchPayload } from "kafkajs";
import { logger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface OpenSearchIndexerConfig {
  // OpenSearch
  opensearchUrl: string;
  indexName: string;
  
  // Kafka/RedPanda
  brokers: string[];
  clientId: string;
  groupId: string;
  firehoseTopic: string;
  tombstoneTopic: string;
  
  // Batching
  batchSize: number;
  flushIntervalMs: number;
}

export interface ActivityDocument {
  activity_id: string;
  activity_type: string;
  actor_uri: string;
  object_id?: string;
  object_type?: string;
  published_at?: string;
  received_at: string;
  indexed_at: string;
  origin: "local" | "remote" | "unknown";
  
  // Denormalized fields for querying
  to?: string[];
  cc?: string[];
  in_reply_to?: string;
  content?: string;
  summary?: string;
  
  // Full activity for retrieval
  activity: any;
}

// ============================================================================
// OpenSearch Indexer
// ============================================================================

export class OpenSearchIndexer {
  private opensearch: Client;
  private kafka: Kafka;
  private consumer: Consumer;
  private config: OpenSearchIndexerConfig;
  private isRunning = false;
  
  // Batching
  private batch: ActivityDocument[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: OpenSearchIndexerConfig) {
    this.config = config;
    
    this.opensearch = new Client({
      node: config.opensearchUrl,
    });
    
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
    });
    
    this.consumer = this.kafka.consumer({
      groupId: config.groupId,
    });
  }

  /**
   * Initialize OpenSearch index
   */
  async initialize(): Promise<void> {
    // Check if index exists
    const exists = await this.opensearch.indices.exists({
      index: this.config.indexName,
    });
    
    if (!exists.body) {
      // Create index with mapping
      await this.opensearch.indices.create({
        index: this.config.indexName,
        body: {
          settings: {
            number_of_shards: 5,
            number_of_replicas: 1,
            refresh_interval: "5s",
          },
          mappings: {
            properties: {
              activity_id: { type: "keyword" },
              activity_type: { type: "keyword" },
              actor_uri: { type: "keyword" },
              object_id: { type: "keyword" },
              object_type: { type: "keyword" },
              published_at: { type: "date" },
              received_at: { type: "date" },
              indexed_at: { type: "date" },
              origin: { type: "keyword" },
              to: { type: "keyword" },
              cc: { type: "keyword" },
              in_reply_to: { type: "keyword" },
              content: { 
                type: "text",
                analyzer: "standard",
              },
              summary: { 
                type: "text",
                analyzer: "standard",
              },
              activity: { 
                type: "object",
                enabled: false,  // Store but don't index
              },
            },
          },
        },
      });
      
      logger.info("Created OpenSearch index", { index: this.config.indexName });
    }
  }

  /**
   * Start consuming from Firehose and indexing
   */
  async start(): Promise<void> {
    this.isRunning = true;
    
    await this.consumer.connect();
    await this.consumer.subscribe({ 
      topics: [this.config.firehoseTopic, this.config.tombstoneTopic],
      fromBeginning: false,
    });
    
    // Start flush timer
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        logger.error("Flush error", { error: err.message });
      });
    }, this.config.flushIntervalMs);
    
    await this.consumer.run({
      eachBatch: async (payload: EachBatchPayload) => {
        await this.processBatch(payload);
      },
    });
    
    logger.info("OpenSearch indexer started", {
      firehoseTopic: this.config.firehoseTopic,
      index: this.config.indexName,
    });
  }

  /**
   * Stop the indexer
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    // Final flush
    await this.flush();
    
    await this.consumer.disconnect();
    
    logger.info("OpenSearch indexer stopped");
  }

  /**
   * Process a batch of messages
   */
  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, isRunning, isStale } = payload;
    
    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;
      
      try {
        const value = message.value?.toString();
        if (!value) continue;
        
        const event = JSON.parse(value);
        
        if (batch.topic === this.config.tombstoneTopic) {
          // Handle tombstone (delete)
          await this.handleTombstone(event);
        } else {
          // Handle activity
          const doc = this.mapActivityToDocument(event);
          if (doc) {
            this.batch.push(doc);
            
            if (this.batch.length >= this.config.batchSize) {
              await this.flush();
            }
          }
        }
        
        resolveOffset(message.offset);
        await heartbeat();
        
      } catch (err: any) {
        logger.error("Error processing message", { 
          topic: batch.topic,
          offset: message.offset,
          error: err.message,
        });
      }
    }
  }

  /**
   * Map activity event to OpenSearch document
   */
  private mapActivityToDocument(event: any): ActivityDocument | null {
    const activity = event.activity;
    if (!activity || !activity.id) return null;
    
    // Extract object info
    let objectId: string | undefined;
    let objectType: string | undefined;
    if (activity.object) {
      if (typeof activity.object === "string") {
        objectId = activity.object;
      } else {
        objectId = activity.object.id;
        objectType = activity.object.type;
      }
    }
    
    // Extract addressing
    const to = this.normalizeAddressing(activity.to);
    const cc = this.normalizeAddressing(activity.cc);
    
    // Extract content
    let content: string | undefined;
    let summary: string | undefined;
    if (activity.object && typeof activity.object === "object") {
      content = activity.object.content;
      summary = activity.object.summary;
    }
    
    // Extract in_reply_to
    let inReplyTo: string | undefined;
    if (activity.object?.inReplyTo) {
      inReplyTo = typeof activity.object.inReplyTo === "string" 
        ? activity.object.inReplyTo 
        : activity.object.inReplyTo.id;
    }
    
    return {
      activity_id: activity.id,
      activity_type: activity.type,
      actor_uri: event.actorUri || activity.actor,
      object_id: objectId,
      object_type: objectType,
      published_at: activity.published,
      received_at: new Date(event.receivedAt || event.streamTimestamp).toISOString(),
      indexed_at: new Date().toISOString(),
      origin: (event.origin as "local" | "remote" | "unknown") || "unknown",
      to,
      cc,
      in_reply_to: inReplyTo,
      content,
      summary,
      activity,
    };
  }

  /**
   * Normalize addressing field to array
   */
  private normalizeAddressing(field: any): string[] | undefined {
    if (!field) return undefined;
    if (Array.isArray(field)) return field;
    return [field];
  }

  /**
   * Handle tombstone (delete) event
   */
  private async handleTombstone(event: any): Promise<void> {
    const { activityId, objectId } = event;
    
    // Delete by activity ID
    if (activityId) {
      await this.opensearch.deleteByQuery({
        index: this.config.indexName,
        body: {
          query: {
            term: { activity_id: activityId },
          },
        },
      });
    }
    
    // Also delete activities referencing this object
    if (objectId) {
      await this.opensearch.deleteByQuery({
        index: this.config.indexName,
        body: {
          query: {
            term: { object_id: objectId },
          },
        },
      });
    }
    
    logger.debug("Processed tombstone", { activityId, objectId });
  }

  /**
   * Flush batch to OpenSearch
   */
  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    
    const docs = this.batch;
    this.batch = [];
    
    try {
      const body = docs.flatMap(doc => [
        { index: { _index: this.config.indexName, _id: doc.activity_id } },
        doc,
      ]);
      
      const response = await this.opensearch.bulk({ body });
      
      if (response.body.errors) {
        const errors = response.body.items
          .filter((item: any) => item.index?.error)
          .map((item: any) => item.index.error);
        logger.error("Bulk indexing errors", { errors: errors.slice(0, 5) });
      }
      
      logger.debug("Flushed to OpenSearch", { count: docs.length });
      
    } catch (err: any) {
      logger.error("Bulk indexing failed", { error: err.message, count: docs.length });
      // Put docs back in batch for retry
      this.batch.unshift(...docs);
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createOpenSearchIndexer(overrides?: Partial<OpenSearchIndexerConfig>): OpenSearchIndexer {
  const config: OpenSearchIndexerConfig = {
    opensearchUrl: process.env.OPENSEARCH_URL || "http://localhost:9200",
    indexName: process.env.OPENSEARCH_INDEX || "activities",
    brokers: (process.env.REDPANDA_BROKERS || "localhost:9092").split(","),
    clientId: process.env.REDPANDA_CLIENT_ID || "opensearch-indexer",
    groupId: process.env.OPENSEARCH_CONSUMER_GROUP || "opensearch-indexer",
    firehoseTopic: process.env.REDPANDA_FIREHOSE_TOPIC || "apub.public.firehose.v1",
    tombstoneTopic: process.env.REDPANDA_TOMBSTONE_TOPIC || "apub.tombstone.v1",
    batchSize: parseInt(process.env.OPENSEARCH_BATCH_SIZE || "500", 10),
    flushIntervalMs: parseInt(process.env.OPENSEARCH_FLUSH_INTERVAL_MS || "5000", 10),
    ...overrides,
  };

  return new OpenSearchIndexer(config);
}
