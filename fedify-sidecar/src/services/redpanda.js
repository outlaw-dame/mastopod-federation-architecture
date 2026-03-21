import { Kafka, Partitioners, logLevel } from 'kafkajs';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * RedPanda service for Kafka-compatible streaming
 * Handles production and consumption of activities across streams
 */
class RedPandaService {
  constructor() {
    this.kafka = null;
    this.producer = null;
    this.consumers = new Map();
    this.isConnected = false;
  }

  /**
   * Initialize the RedPanda connection
   */
  async initialize() {
    try {
      // Create Kafka client
      this.kafka = new Kafka({
        clientId: config.redpanda.clientId,
        brokers: config.redpanda.brokers,
        logLevel: logLevel.WARN,
        retry: {
          initialRetryTime: 100,
          retries: 8,
        },
      });

      // Create and connect producer
      this.producer = this.kafka.producer({
        createPartitioner: Partitioners.DefaultPartitioner,
        allowAutoTopicCreation: config.redpanda.producer.allowAutoTopicCreation,
        transactionTimeout: config.redpanda.producer.transactionTimeout,
      });

      await this.producer.connect();
      this.isConnected = true;

      logger.info('RedPanda service initialized successfully');
      logger.info(`Connected to brokers: ${config.redpanda.brokers.join(', ')}`);
    } catch (err) {
      logger.error('Failed to initialize RedPanda service:', err);
      throw err;
    }
  }

  /**
   * Publish an activity to a topic
   * @param {string} topic - Topic name
   * @param {string} key - Message key (usually actorUri)
   * @param {Object} value - Activity data
   * @param {Object} [headers] - Optional headers
   */
  async publish(topic, key, value, headers = {}) {
    if (!this.isConnected) {
      throw new Error('RedPanda producer not connected');
    }

    try {
      const message = {
        key,
        value: JSON.stringify(value),
        headers: {
          'content-type': 'application/activity+json',
          'published-at': new Date().toISOString(),
          ...headers,
        },
      };

      await this.producer.send({
        topic,
        messages: [message],
      });

      logger.debug(`Published to ${topic}: ${key}`);
    } catch (err) {
      logger.error(`Failed to publish to ${topic}:`, err);
      throw err;
    }
  }

  /**
   * Publish to Stream1 (local public activities)
   * @param {string} actorUri - The actor URI
   * @param {Object} activity - The activity data
   */
  async publishToStream1(actorUri, activity) {
    await this.publish(
      config.redpanda.topics.stream1,
      actorUri,
      {
        actorUri,
        activity,
        origin: 'local',
        publishedAt: new Date().toISOString(),
      },
      { origin: 'local' }
    );
  }

  /**
   * Publish to Stream2 (remote public activities)
   * @param {string} actorUri - The actor URI
   * @param {Object} activity - The activity data
   * @param {string} sourceDomain - The source domain
   */
  async publishToStream2(actorUri, activity, sourceDomain) {
    await this.publish(
      config.redpanda.topics.stream2,
      actorUri,
      {
        actorUri,
        activity,
        origin: 'remote',
        sourceDomain,
        publishedAt: new Date().toISOString(),
      },
      { origin: 'remote', 'source-domain': sourceDomain }
    );
  }

  /**
   * Publish to Firehose (combined stream)
   * @param {string} actorUri - The actor URI
   * @param {Object} activity - The activity data
   * @param {string} origin - 'local' or 'remote'
   */
  async publishToFirehose(actorUri, activity, origin) {
    await this.publish(
      config.redpanda.topics.firehose,
      actorUri,
      {
        actorUri,
        activity,
        origin,
        indexedAt: new Date().toISOString(),
      },
      { origin }
    );
  }

  /**
   * Create a consumer for a topic
   * @param {string} groupId - Consumer group ID
   * @param {string} topic - Topic to consume from
   * @param {Function} handler - Message handler function
   * @returns {Object} - Consumer instance
   */
  async createConsumer(groupId, topic, handler) {
    try {
      const consumer = this.kafka.consumer({
        groupId,
        sessionTimeout: config.redpanda.consumer.sessionTimeout,
        heartbeatInterval: config.redpanda.consumer.heartbeatInterval,
        maxBytesPerPartition: config.redpanda.consumer.maxBytesPerPartition,
      });

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });

      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const key = message.key?.toString();
            const value = JSON.parse(message.value.toString());
            const headers = {};
            
            for (const [k, v] of Object.entries(message.headers || {})) {
              headers[k] = v?.toString();
            }

            await handler({
              topic,
              partition,
              offset: message.offset,
              key,
              value,
              headers,
              timestamp: message.timestamp,
            });
          } catch (err) {
            logger.error(`Error processing message from ${topic}:`, err);
          }
        },
      });

      this.consumers.set(`${groupId}:${topic}`, consumer);
      logger.info(`Consumer started for ${topic} (group: ${groupId})`);

      return consumer;
    } catch (err) {
      logger.error(`Failed to create consumer for ${topic}:`, err);
      throw err;
    }
  }

  /**
   * Start the delivery consumer (consumes from Stream1 for remote delivery)
   * @param {Function} handler - Handler for delivery messages
   */
  async startDeliveryConsumer(handler) {
    return this.createConsumer(
      config.redpanda.consumerGroups.delivery,
      config.redpanda.topics.stream1,
      handler
    );
  }

  /**
   * Get admin client for topic management
   * @returns {Object} - Admin client
   */
  getAdmin() {
    return this.kafka.admin();
  }

  /**
   * Ensure topics exist
   */
  async ensureTopics() {
    const admin = this.getAdmin();
    await admin.connect();

    try {
      const topics = [
        { topic: config.redpanda.topics.stream1, numPartitions: 12, replicationFactor: 1 },
        { topic: config.redpanda.topics.stream2, numPartitions: 12, replicationFactor: 1 },
        { topic: config.redpanda.topics.firehose, numPartitions: 24, replicationFactor: 1 },
      ];

      const existingTopics = await admin.listTopics();
      const topicsToCreate = topics.filter(t => !existingTopics.includes(t.topic));

      if (topicsToCreate.length > 0) {
        await admin.createTopics({ topics: topicsToCreate });
        logger.info(`Created topics: ${topicsToCreate.map(t => t.topic).join(', ')}`);
      }
    } finally {
      await admin.disconnect();
    }
  }

  /**
   * Close all connections
   */
  async close() {
    for (const [key, consumer] of this.consumers) {
      await consumer.disconnect();
      logger.debug(`Disconnected consumer: ${key}`);
    }
    this.consumers.clear();

    if (this.producer) {
      await this.producer.disconnect();
    }

    this.isConnected = false;
    logger.info('RedPanda connections closed');
  }
}

export const redpandaService = new RedPandaService();
export default redpandaService;
