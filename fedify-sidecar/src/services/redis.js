import Redis from 'ioredis';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Redis service for handling pub/sub and key-value operations
 */
class RedisService {
  constructor() {
    this.publisher = null;
    this.subscriber = null;
    this.client = null;
    this.subscriptions = new Map();
  }

  /**
   * Initialize Redis connections
   */
  async initialize() {
    try {
      // Main client for general operations
      this.client = new Redis(config.redis.url, {
        keyPrefix: config.redis.keyPrefix,
        retryDelayOnFailover: 1000,
        maxRetriesPerRequest: 3,
      });

      // Publisher for pub/sub
      this.publisher = new Redis(config.redis.url, {
        keyPrefix: config.redis.keyPrefix,
      });

      // Subscriber for pub/sub
      this.subscriber = new Redis(config.redis.url, {
        keyPrefix: config.redis.keyPrefix,
      });

      // Set up error handlers
      this.client.on('error', (err) => logger.error('Redis client error:', err));
      this.publisher.on('error', (err) => logger.error('Redis publisher error:', err));
      this.subscriber.on('error', (err) => logger.error('Redis subscriber error:', err));

      // Handle incoming messages
      this.subscriber.on('message', (channel, message) => {
        const handler = this.subscriptions.get(channel);
        if (handler) {
          try {
            const data = JSON.parse(message);
            handler(data);
          } catch (err) {
            logger.error(`Error parsing message from ${channel}:`, err);
          }
        }
      });

      logger.info('Redis service initialized successfully');
    } catch (err) {
      logger.error('Failed to initialize Redis service:', err);
      throw err;
    }
  }

  /**
   * Subscribe to a channel
   * @param {string} channel - Channel name
   * @param {Function} handler - Message handler function
   */
  async subscribe(channel, handler) {
    this.subscriptions.set(channel, handler);
    await this.subscriber.subscribe(channel);
    logger.info(`Subscribed to channel: ${channel}`);
  }

  /**
   * Publish a message to a channel
   * @param {string} channel - Channel name
   * @param {Object} data - Data to publish
   */
  async publish(channel, data) {
    const message = JSON.stringify(data);
    await this.publisher.publish(channel, message);
    logger.debug(`Published message to ${channel}`);
  }

  /**
   * Get a value from Redis
   * @param {string} key - Key to retrieve
   * @returns {Promise<any>}
   */
  async get(key) {
    const value = await this.client.get(key);
    return value ? JSON.parse(value) : null;
  }

  /**
   * Set a value in Redis
   * @param {string} key - Key to set
   * @param {any} value - Value to store
   * @param {number} [ttl] - Optional TTL in seconds
   */
  async set(key, value, ttl = null) {
    const serialized = JSON.stringify(value);
    if (ttl) {
      await this.client.setex(key, ttl, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }

  /**
   * Check if a key exists (for deduplication)
   * @param {string} key - Key to check
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    const result = await this.client.exists(key);
    return result === 1;
  }

  /**
   * Set a key with NX (only if not exists) for deduplication
   * @param {string} key - Key to set
   * @param {number} ttl - TTL in seconds
   * @returns {Promise<boolean>} - True if key was set, false if already exists
   */
  async setNX(key, ttl) {
    const result = await this.client.set(key, '1', 'EX', ttl, 'NX');
    return result === 'OK';
  }

  /**
   * Close all Redis connections
   */
  async close() {
    await this.client?.quit();
    await this.publisher?.quit();
    await this.subscriber?.quit();
    logger.info('Redis connections closed');
  }
}

export const redisService = new RedisService();
export default redisService;
