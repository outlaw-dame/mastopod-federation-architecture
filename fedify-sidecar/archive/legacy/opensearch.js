import { Client } from '@opensearch-project/opensearch';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import redpandaService from './redpanda.js';

/**
 * OpenSearch service for activity indexing and querying
 * Consumes from Firehose and indexes all public activities
 */
class OpenSearchService {
  constructor() {
    this.client = null;
    this.bulkBuffer = [];
    this.bulkTimer = null;
    this.isConnected = false;
    this.stats = {
      indexed: 0,
      failed: 0,
    };
  }

  /**
   * Initialize the OpenSearch connection
   */
  async initialize() {
    try {
      // Create OpenSearch client
      this.client = new Client({
        node: config.opensearch.node,
        auth: config.opensearch.auth,
        ssl: {
          rejectUnauthorized: false, // For development; enable in production
        },
      });

      // Test connection
      const info = await this.client.info();
      logger.info(`Connected to OpenSearch: ${info.body.version.distribution} ${info.body.version.number}`);

      // Ensure index exists
      await this.ensureIndex();

      // Start bulk flush timer
      this.startBulkFlushTimer();

      // Start consuming from Firehose
      await this.startFirehoseConsumer();

      this.isConnected = true;
      logger.info('OpenSearch service initialized');
    } catch (err) {
      logger.error('Failed to initialize OpenSearch service:', err);
      throw err;
    }
  }

  /**
   * Ensure the activities index exists with proper mappings
   */
  async ensureIndex() {
    const indexName = config.opensearch.indices.activities;

    try {
      const exists = await this.client.indices.exists({ index: indexName });

      if (!exists.body) {
        await this.client.indices.create({
          index: indexName,
          body: {
            settings: {
              number_of_shards: 3,
              number_of_replicas: 1,
              analysis: {
                analyzer: {
                  content_analyzer: {
                    type: 'custom',
                    tokenizer: 'standard',
                    filter: ['lowercase', 'stop', 'snowball'],
                  },
                },
              },
            },
            mappings: {
              properties: {
                // Activity identity
                id: { type: 'keyword' },
                type: { type: 'keyword' },
                
                // Actor information
                actor: { type: 'keyword' },
                actor_domain: { type: 'keyword' },
                actor_name: { type: 'text' },
                
                // Timestamps
                published: { type: 'date' },
                indexed_at: { type: 'date' },
                
                // Content (for full-text search)
                content: { 
                  type: 'text',
                  analyzer: 'content_analyzer',
                  fields: {
                    raw: { type: 'keyword' },
                  },
                },
                summary: { type: 'text' },
                name: { type: 'text' },
                
                // Object (nested for complex objects)
                object: {
                  type: 'object',
                  enabled: true,
                  properties: {
                    id: { type: 'keyword' },
                    type: { type: 'keyword' },
                    content: { type: 'text', analyzer: 'content_analyzer' },
                    url: { type: 'keyword' },
                    attributedTo: { type: 'keyword' },
                  },
                },
                
                // Target
                target: {
                  type: 'object',
                  properties: {
                    id: { type: 'keyword' },
                    type: { type: 'keyword' },
                  },
                },
                
                // Addressing
                to: { type: 'keyword' },
                cc: { type: 'keyword' },
                
                // Metadata
                origin: { type: 'keyword' }, // 'local' or 'remote'
                source_domain: { type: 'keyword' },
                
                // Tags and mentions
                tags: { type: 'keyword' },
                mentions: { type: 'keyword' },
                
                // Engagement (for aggregations)
                in_reply_to: { type: 'keyword' },
                
                // Full activity JSON for reference
                raw_activity: { type: 'object', enabled: false },
              },
            },
          },
        });

        logger.info(`Created index: ${indexName}`);
      }
    } catch (err) {
      logger.error('Failed to ensure index:', err);
      throw err;
    }
  }

  /**
   * Start consuming from Firehose for indexing
   */
  async startFirehoseConsumer() {
    await redpandaService.createConsumer(
      config.redpanda.consumerGroups.indexer,
      config.redpanda.topics.firehose,
      this.handleFirehoseMessage.bind(this)
    );
  }

  /**
   * Handle a message from Firehose
   * @param {Object} message - Kafka message
   */
  async handleFirehoseMessage(message) {
    const { value } = message;
    const { actorUri, activity, origin } = value;

    try {
      const document = this.mapActivityToDocument(activity, actorUri, origin);
      await this.indexDocument(document);
    } catch (err) {
      logger.error('Error indexing activity:', err);
      this.stats.failed++;
    }
  }

  /**
   * Map an ActivityPub activity to an OpenSearch document
   * @param {Object} activity - The activity
   * @param {string} actorUri - The actor URI
   * @param {string} origin - 'local' or 'remote'
   * @returns {Object} - OpenSearch document
   */
  mapActivityToDocument(activity, actorUri, origin) {
    const activityId = activity.id || activity['@id'];
    const actorDomain = new URL(actorUri).hostname;

    // Extract content from activity or object
    let content = activity.content || '';
    let objectData = null;

    if (activity.object) {
      if (typeof activity.object === 'string') {
        objectData = { id: activity.object };
      } else {
        objectData = {
          id: activity.object.id || activity.object['@id'],
          type: activity.object.type,
          content: activity.object.content,
          url: activity.object.url,
          attributedTo: activity.object.attributedTo,
        };
        content = content || activity.object.content || '';
      }
    }

    // Extract tags and mentions
    const tags = [];
    const mentions = [];
    
    if (activity.tag) {
      const tagArray = Array.isArray(activity.tag) ? activity.tag : [activity.tag];
      for (const tag of tagArray) {
        if (tag.type === 'Hashtag') {
          tags.push(tag.name || tag.href);
        } else if (tag.type === 'Mention') {
          mentions.push(tag.href);
        }
      }
    }

    return {
      id: activityId,
      type: activity.type,
      actor: actorUri,
      actor_domain: actorDomain,
      published: activity.published || new Date().toISOString(),
      indexed_at: new Date().toISOString(),
      content: this.stripHtml(content),
      summary: activity.summary,
      name: activity.name,
      object: objectData,
      target: activity.target ? {
        id: typeof activity.target === 'string' ? activity.target : activity.target.id,
        type: activity.target?.type,
      } : null,
      to: this.normalizeAddressing(activity.to),
      cc: this.normalizeAddressing(activity.cc),
      origin,
      source_domain: origin === 'remote' ? actorDomain : null,
      tags,
      mentions,
      in_reply_to: activity.inReplyTo || activity.object?.inReplyTo,
      raw_activity: activity,
    };
  }

  /**
   * Strip HTML tags from content
   * @param {string} html - HTML content
   * @returns {string} - Plain text
   */
  stripHtml(html) {
    if (!html) return '';
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Normalize addressing fields to arrays
   * @param {*} addressing - Addressing field value
   * @returns {Array<string>}
   */
  normalizeAddressing(addressing) {
    if (!addressing) return [];
    if (Array.isArray(addressing)) {
      return addressing.map(a => typeof a === 'string' ? a : a.id || a['@id']).filter(Boolean);
    }
    return [typeof addressing === 'string' ? addressing : addressing.id || addressing['@id']].filter(Boolean);
  }

  /**
   * Index a document (buffered for bulk operations)
   * @param {Object} document - Document to index
   */
  async indexDocument(document) {
    this.bulkBuffer.push({
      index: { _index: config.opensearch.indices.activities, _id: document.id },
    });
    this.bulkBuffer.push(document);

    // Flush if buffer is large enough
    if (JSON.stringify(this.bulkBuffer).length >= config.opensearch.bulk.flushBytes) {
      await this.flushBulk();
    }
  }

  /**
   * Start the bulk flush timer
   */
  startBulkFlushTimer() {
    this.bulkTimer = setInterval(async () => {
      if (this.bulkBuffer.length > 0) {
        await this.flushBulk();
      }
    }, config.opensearch.bulk.flushInterval);
  }

  /**
   * Flush the bulk buffer to OpenSearch
   */
  async flushBulk() {
    if (this.bulkBuffer.length === 0) return;

    const buffer = this.bulkBuffer;
    this.bulkBuffer = [];

    try {
      const response = await this.client.bulk({ body: buffer });

      if (response.body.errors) {
        const errors = response.body.items.filter(item => item.index?.error);
        logger.error(`Bulk indexing errors: ${errors.length}`);
        this.stats.failed += errors.length;
        this.stats.indexed += (buffer.length / 2) - errors.length;
      } else {
        this.stats.indexed += buffer.length / 2;
        logger.debug(`Indexed ${buffer.length / 2} documents`);
      }
    } catch (err) {
      logger.error('Bulk indexing failed:', err);
      this.stats.failed += buffer.length / 2;
    }
  }

  /**
   * Search activities
   * @param {Object} query - Search query
   * @returns {Promise<Object>} - Search results
   */
  async search(query) {
    const { q, type, actor, domain, origin, from, size, sort } = query;

    const must = [];
    const filter = [];

    // Full-text search
    if (q) {
      must.push({
        multi_match: {
          query: q,
          fields: ['content', 'summary', 'name', 'object.content'],
          type: 'best_fields',
        },
      });
    }

    // Filters
    if (type) {
      filter.push({ term: { type } });
    }
    if (actor) {
      filter.push({ term: { actor } });
    }
    if (domain) {
      filter.push({ term: { actor_domain: domain } });
    }
    if (origin) {
      filter.push({ term: { origin } });
    }

    const body = {
      query: {
        bool: {
          must: must.length > 0 ? must : [{ match_all: {} }],
          filter,
        },
      },
      from: from || 0,
      size: size || 20,
      sort: sort || [{ indexed_at: 'desc' }],
    };

    const response = await this.client.search({
      index: config.opensearch.indices.activities,
      body,
    });

    return {
      total: response.body.hits.total.value,
      hits: response.body.hits.hits.map(hit => ({
        id: hit._id,
        score: hit._score,
        ...hit._source,
      })),
    };
  }

  /**
   * Get aggregations for analytics
   * @param {Object} options - Aggregation options
   * @returns {Promise<Object>} - Aggregation results
   */
  async getAggregations(options = {}) {
    const { interval = 'day', field = 'type', size = 10 } = options;

    const body = {
      size: 0,
      aggs: {
        by_time: {
          date_histogram: {
            field: 'indexed_at',
            calendar_interval: interval,
          },
        },
        by_type: {
          terms: {
            field: 'type',
            size,
          },
        },
        by_domain: {
          terms: {
            field: 'actor_domain',
            size,
          },
        },
        by_origin: {
          terms: {
            field: 'origin',
            size: 2,
          },
        },
      },
    };

    const response = await this.client.search({
      index: config.opensearch.indices.activities,
      body,
    });

    return {
      by_time: response.body.aggregations.by_time.buckets,
      by_type: response.body.aggregations.by_type.buckets,
      by_domain: response.body.aggregations.by_domain.buckets,
      by_origin: response.body.aggregations.by_origin.buckets,
    };
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Close connections
   */
  async close() {
    if (this.bulkTimer) {
      clearInterval(this.bulkTimer);
    }
    
    // Flush remaining documents
    await this.flushBulk();

    if (this.client) {
      await this.client.close();
    }

    logger.info('OpenSearch service closed');
  }
}

export const opensearchService = new OpenSearchService();
export default opensearchService;
