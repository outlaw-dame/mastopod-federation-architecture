/**
 * OpenSearch Service
 * 
 * Handles indexing of public activities from the Firehose into OpenSearch.
 * OpenSearch serves as the queryable store for all public activities.
 */

import { Client } from "@opensearch-project/opensearch";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import { metrics } from "../metrics/index.js";
import type { StreamActivity } from "../streams/index.js";
import {
  extractHashtagsFromActivityPubTags,
  extractHashtagsFromText,
  normalizeHashtag,
} from "../utils/hashtags.js";
import { extractApEmojiReactionContent } from "../utils/apEmojiReactions.js";

// Index mapping for activities
const ACTIVITY_INDEX_MAPPING = {
  mappings: {
    properties: {
      id: { type: "keyword" },
      type: { type: "keyword" },
      actor: { type: "keyword" },
      actor_domain: { type: "keyword" },
      object_id: { type: "keyword" },
      object_type: { type: "keyword" },
      object_content: { type: "text", analyzer: "standard" },
      published: { type: "date" },
      received_at: { type: "date", format: "epoch_millis" },
      indexed_at: { type: "date" },
      origin: { type: "keyword" },
      visibility: { type: "keyword" },
      
      // Nested object for full activity data
      raw: { type: "object", enabled: false },
      
      // Extracted fields for common queries
      in_reply_to: { type: "keyword" },
      hashtags: { type: "keyword" },
      reaction_content: { type: "keyword" },
      mentions: { type: "keyword" },
      attachments: {
        type: "nested",
        properties: {
          type: { type: "keyword" },
          media_type: { type: "keyword" },
          url: { type: "keyword" },
        },
      },
    },
  },
  settings: {
    number_of_shards: 3,
    number_of_replicas: 1,
    refresh_interval: "5s",
    "index.mapping.total_fields.limit": 2000,
  },
};

export interface ActivityDocument {
  id: string;
  type: string;
  actor: string;
  actor_domain: string;
  object_id?: string;
  object_type?: string;
  object_content?: string;
  published: string;
  received_at: number;
  indexed_at: string;
  origin: string;
  visibility: string;
  raw: unknown;
  in_reply_to?: string;
  hashtags?: string[];
  reaction_content?: string;
  mentions?: string[];
  attachments?: Array<{
    type: string;
    media_type?: string;
    url: string;
  }>;
}

export class OpenSearchService {
  private client: Client;
  private indexName: string;
  private isInitialized = false;

  constructor() {
    const clientConfig: any = {
      node: config.opensearch.node,
      ssl: config.opensearch.ssl ? { rejectUnauthorized: false } : undefined,
    };

    if (config.opensearch.username && config.opensearch.password) {
      clientConfig.auth = {
        username: config.opensearch.username,
        password: config.opensearch.password,
      };
    }

    this.client = new Client(clientConfig);
    this.indexName = `${config.opensearch.indexPrefix}-activities`;
  }

  /**
   * Initialize the OpenSearch service and create index if needed
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    logger.info("Initializing OpenSearch service...");

    try {
      // Check if index exists
      const indexExists = await this.client.indices.exists({
        index: this.indexName,
      });

      if (!indexExists.body) {
        logger.info("Creating activities index", { indexName: this.indexName });
        
        await this.client.indices.create({
          index: this.indexName,
          body: ACTIVITY_INDEX_MAPPING,
        });
      } else {
        await this.client.indices.putMapping({
          index: this.indexName,
          body: {
            properties: {
              reaction_content: { type: "keyword" },
            },
          },
        });
      }

      this.isInitialized = true;
      logger.info("OpenSearch service initialized");
    } catch (error) {
      logger.error("Failed to initialize OpenSearch", { error });
      throw error;
    }
  }

  /**
   * Index a single activity
   */
  async indexActivity(activity: StreamActivity): Promise<void> {
    const startTime = Date.now();

    try {
      const document = this.mapActivityToDocument(activity);

      await this.client.index({
        index: this.indexName,
        id: document.id,
        body: document,
        refresh: false, // Don't wait for refresh
      });

      const duration = Date.now() - startTime;
      metrics.opensearchIndexLatency.observe(duration / 1000);
      metrics.opensearchIndexTotal.inc({ status: "success" });

      logger.debug("Activity indexed", { id: activity.id, durationMs: duration });
    } catch (error) {
      metrics.opensearchIndexTotal.inc({ status: "error" });
      logger.error("Failed to index activity", { id: activity.id, error });
      throw error;
    }
  }

  /**
   * Bulk index multiple activities
   */
  async bulkIndexActivities(activities: StreamActivity[]): Promise<void> {
    if (activities.length === 0) {
      return;
    }

    const startTime = Date.now();

    try {
      const operations = activities.flatMap((activity) => {
        const document = this.mapActivityToDocument(activity);
        return [
          { index: { _index: this.indexName, _id: document.id } },
          document,
        ];
      });

      const response = await this.client.bulk({
        body: operations,
        refresh: false,
      });

      const duration = Date.now() - startTime;
      metrics.opensearchIndexLatency.observe(duration / 1000);

      if (response.body.errors) {
        const errorCount = response.body.items.filter(
          (item: any) => item.index?.error
        ).length;
        
        logger.warn("Bulk index had errors", {
          total: activities.length,
          errors: errorCount,
          durationMs: duration,
        });

        metrics.opensearchIndexTotal.inc({ status: "success" }, activities.length - errorCount);
        metrics.opensearchIndexTotal.inc({ status: "error" }, errorCount);
      } else {
        metrics.opensearchIndexTotal.inc({ status: "success" }, activities.length);
        
        logger.debug("Bulk index successful", {
          count: activities.length,
          durationMs: duration,
        });
      }
    } catch (error) {
      metrics.opensearchIndexTotal.inc({ status: "error" }, activities.length);
      logger.error("Bulk index failed", { count: activities.length, error });
      throw error;
    }
  }

  /**
   * Map StreamActivity to OpenSearch document
   */
  private mapActivityToDocument(activity: StreamActivity): ActivityDocument {
    const raw = activity.raw as Record<string, unknown>;
    const object = raw.object as Record<string, unknown> | undefined;

    // Extract object details
    let objectId: string | undefined;
    let objectType: string | undefined;
    let objectContent: string | undefined;
    let inReplyTo: string | undefined;

    if (object) {
      objectId = (object.id ?? object["@id"]) as string | undefined;
      objectType = (object.type ?? object["@type"]) as string | undefined;
      objectContent = object.content as string | undefined;
      inReplyTo = object.inReplyTo as string | undefined;
    } else if (typeof raw.object === "string") {
      objectId = raw.object;
    }

    // Extract hashtags
    const hashtags = this.extractHashtags(object);

    // Extract AP EmojiReact / Like+content reaction token
    const reactionContent = extractApEmojiReactionContent(raw);

    if (!objectContent && reactionContent) {
      objectContent = reactionContent;
    }

    // Extract mentions
    const mentions = this.extractMentions(object);

    // Extract attachments
    const attachments = this.extractAttachments(object);

    return {
      id: activity.id,
      type: activity.type,
      actor: activity.actor,
      actor_domain: activity.actorDomain,
      object_id: objectId,
      object_type: objectType,
      object_content: objectContent,
      published: activity.published,
      received_at: activity.receivedAt,
      indexed_at: new Date().toISOString(),
      origin: activity.origin,
      visibility: activity.visibility,
      raw: activity.raw,
      in_reply_to: inReplyTo,
      hashtags,
      reaction_content: reactionContent,
      mentions,
      attachments,
    };
  }

  /**
   * Extract hashtags from object
   */
  private extractHashtags(object?: Record<string, unknown>): string[] {
    const fromTags = extractHashtagsFromActivityPubTags(object?.tag);
    const fromContent =
      typeof object?.content === "string" ? extractHashtagsFromText(object.content) : [];

    return Array.from(new Set([...fromTags, ...fromContent]));
  }

  /**
   * Extract mentions from object
   */
  private extractMentions(object?: Record<string, unknown>): string[] {
    if (!object?.tag) {
      return [];
    }

    const tags = Array.isArray(object.tag) ? object.tag : [object.tag];
    
    return tags
      .filter((tag: any) => tag.type === "Mention" && tag.href)
      .map((tag: any) => tag.href);
  }

  /**
   * Extract attachments from object
   */
  private extractAttachments(
    object?: Record<string, unknown>
  ): ActivityDocument["attachments"] {
    if (!object?.attachment) {
      return [];
    }

    const attachments = Array.isArray(object.attachment)
      ? object.attachment
      : [object.attachment];

    return attachments
      .filter((att: any) => att.url)
      .map((att: any) => ({
        type: att.type ?? "Document",
        media_type: att.mediaType,
        url: att.url,
      }));
  }

  /**
   * Search activities
   */
  async searchActivities(query: {
    text?: string;
    type?: string;
    actor?: string;
    actorDomain?: string;
    hashtag?: string;
    reaction?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; activities: ActivityDocument[] }> {
    const must: any[] = [];

    if (query.text) {
      must.push({
        match: { object_content: query.text },
      });
    }

    if (query.type) {
      must.push({ term: { type: query.type } });
    }

    if (query.actor) {
      must.push({ term: { actor: query.actor } });
    }

    if (query.actorDomain) {
      must.push({ term: { actor_domain: query.actorDomain } });
    }

    if (query.hashtag) {
      const normalizedHashtag = normalizeHashtag(query.hashtag, {
        allowMissingHash: true,
      });
      if (normalizedHashtag) {
        must.push({ term: { hashtags: normalizedHashtag } });
      }
    }

    if (query.reaction) {
      const reaction = extractApEmojiReactionContent({ type: 'Like', content: query.reaction });
      if (reaction) {
        must.push({ term: { reaction_content: reaction } });
      }
    }

    if (query.from || query.to) {
      must.push({
        range: {
          published: {
            ...(query.from && { gte: query.from }),
            ...(query.to && { lte: query.to }),
          },
        },
      });
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: must.length > 0 ? { bool: { must } } : { match_all: {} },
        sort: [{ published: { order: "desc" } }],
        size: query.limit ?? 20,
        from: query.offset ?? 0,
      },
    });

    return {
      total: response.body.hits.total.value,
      activities: response.body.hits.hits.map((hit: any) => hit._source),
    };
  }

  /**
   * Get activity by ID
   */
  async getActivity(id: string): Promise<ActivityDocument | null> {
    try {
      const response = await this.client.get({
        index: this.indexName,
        id,
      });

      return response.body._source;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Close the client connection
   */
  async close(): Promise<void> {
    await this.client.close();
    this.isInitialized = false;
    logger.info("OpenSearch service closed");
  }
}

// Export singleton instance
export const openSearchService = new OpenSearchService();
