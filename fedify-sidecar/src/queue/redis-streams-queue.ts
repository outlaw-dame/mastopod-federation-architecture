/**
 * Redis Streams Message Queue for Fedify
 * 
 * Implements Fedify's MessageQueue interface using Redis Streams with consumer groups.
 * 
 * Key design decisions:
 * - Implements Fedify's MessageQueue interface (enqueue, listen)
 * - Redis Streams for durable message storage
 * - Consumer groups for distributed processing
 * - XAUTOCLAIM for crash recovery
 * - Delayed messages via Redis Sorted Set
 * - nativeRetrial = false (Fedify handles retries)
 */

import type {
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import { createClient, RedisClientType } from "redis";
import { logger } from "../utils/logger.js";

// ============================================================================
// Configuration
// ============================================================================

export interface RedisStreamsQueueOptions {
  /**
   * Redis connection URL
   * @default "redis://localhost:6379"
   */
  redisUrl?: string;

  /**
   * The stream key for immediate messages
   * @default "fedify:queue"
   */
  streamKey?: string;

  /**
   * The sorted set key for delayed messages
   * @default "fedify:delayed"
   */
  delayedKey?: string;

  /**
   * The Pub/Sub channel for notifications
   * @default "fedify:notify"
   */
  channelKey?: string;

  /**
   * Consumer group name
   * @default "fedify-workers"
   */
  consumerGroup?: string;

  /**
   * Unique consumer ID (should be unique per worker)
   * @default auto-generated
   */
  consumerId?: string;

  /**
   * How long to block waiting for new messages (ms)
   * @default 5000
   */
  blockTimeoutMs?: number;

  /**
   * How long before a message is considered idle and can be claimed (ms)
   * @default 60000
   */
  claimIdleTimeMs?: number;

  /**
   * Poll interval for delayed messages (ms)
   * @default 1000
   */
  delayedPollIntervalMs?: number;

  /**
   * Maximum stream length (approximate, uses MAXLEN ~)
   * @default 100000
   */
  maxStreamLength?: number;
}

// ============================================================================
// Redis Streams MessageQueue Implementation
// ============================================================================

/**
 * A MessageQueue implementation using Redis Streams.
 * 
 * This implementation uses:
 * - Redis Streams (XADD/XREADGROUP) for immediate message delivery
 * - Redis Sorted Set (ZADD/ZRANGEBYSCORE) for delayed messages
 * - Redis Pub/Sub for instant notification when messages are ready
 * - Consumer groups for distributed processing
 * - XAUTOCLAIM for crash recovery
 * 
 * @example
 * ```ts
 * import { createFederation } from "@fedify/fedify";
 * import { RedisStreamsMessageQueue } from "./queue/redis-streams-queue.js";
 * 
 * const federation = createFederation({
 *   queue: new RedisStreamsMessageQueue({
 *     redisUrl: "redis://localhost:6379",
 *   }),
 *   // ... other options
 * });
 * ```
 */
export class RedisStreamsMessageQueue implements MessageQueue, Disposable {
  /**
   * Indicates whether this queue has native retry support.
   * Set to false so Fedify handles retries.
   */
  readonly nativeRetrial = false;

  private redis: RedisClientType;
  private subRedis: RedisClientType;
  private readonly streamKey: string;
  private readonly delayedKey: string;
  private readonly channelKey: string;
  private readonly consumerGroup: string;
  private readonly consumerId: string;
  private readonly blockTimeoutMs: number;
  private readonly claimIdleTimeMs: number;
  private readonly delayedPollIntervalMs: number;
  private readonly maxStreamLength: number;

  private isConnected = false;
  private isListening = false;

  constructor(options: RedisStreamsQueueOptions = {}) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";
    
    this.redis = createClient({ url: redisUrl });
    this.subRedis = createClient({ url: redisUrl });
    
    this.streamKey = options.streamKey ?? "fedify:queue";
    this.delayedKey = options.delayedKey ?? "fedify:delayed";
    this.channelKey = options.channelKey ?? "fedify:notify";
    this.consumerGroup = options.consumerGroup ?? "fedify-workers";
    this.consumerId = options.consumerId ?? `worker-${process.pid}-${Date.now()}`;
    this.blockTimeoutMs = options.blockTimeoutMs ?? 5000;
    this.claimIdleTimeMs = options.claimIdleTimeMs ?? 60000;
    this.delayedPollIntervalMs = options.delayedPollIntervalMs ?? 1000;
    this.maxStreamLength = options.maxStreamLength ?? 100000;

    this.redis.on("error", (err) => {
      logger.error("Redis client error", { error: err.message });
    });
    
    this.subRedis.on("error", (err) => {
      logger.error("Redis sub client error", { error: err.message });
    });
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  private async ensureConnected(): Promise<void> {
    if (this.isConnected) return;

    await Promise.all([
      this.redis.connect(),
      this.subRedis.connect(),
    ]);

    // Create consumer group if it doesn't exist
    try {
      await this.redis.xGroupCreate(this.streamKey, this.consumerGroup, "0", { MKSTREAM: true });
      logger.info("Created consumer group", { stream: this.streamKey, group: this.consumerGroup });
    } catch (err: any) {
      // BUSYGROUP means group already exists, which is fine
      if (!err.message?.includes("BUSYGROUP")) {
        throw err;
      }
    }

    this.isConnected = true;
    logger.info("Redis Streams MessageQueue connected", {
      streamKey: this.streamKey,
      consumerId: this.consumerId,
    });
  }

  // ==========================================================================
  // MessageQueue Interface: enqueue
  // ==========================================================================

  /**
   * Enqueue a message to the queue.
   * 
   * If options.delay is provided, the message is stored in a sorted set
   * and will be moved to the stream when the delay expires.
   * 
   * @param message - The message to enqueue (will be JSON serialized)
   * @param options - Optional settings including delay
   */
  async enqueue(message: unknown, options?: MessageQueueEnqueueOptions): Promise<void> {
    await this.ensureConnected();

    const serialized = JSON.stringify(message);
    const messageId = crypto.randomUUID();

    if (options?.delay != null) {
      // Delayed message: store in sorted set with score = timestamp when ready
      const delayMs = durationToMs(options.delay);
      const readyAt = Date.now() + delayMs;
      
      await this.redis.zAdd(this.delayedKey, {
        score: readyAt,
        value: JSON.stringify({ id: messageId, data: serialized }),
      });
      
      logger.debug("Enqueued delayed message", { messageId, readyAt, delayMs });
    } else {
      // Immediate message: add to stream and notify
      await this.redis.xAdd(
        this.streamKey,
        "*",
        { id: messageId, data: serialized },
        { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } }
      );
      
      // Notify listeners that a message is available
      await this.redis.publish(this.channelKey, "new");
      
      logger.debug("Enqueued immediate message", { messageId });
    }
  }

  /**
   * Enqueue multiple messages at once for better performance.
   * 
   * @param messages - Array of messages to enqueue
   * @param options - Optional settings including delay (applied to all)
   */
  async enqueueMany(messages: readonly unknown[], options?: MessageQueueEnqueueOptions): Promise<void> {
    if (messages.length === 0) return;
    
    await this.ensureConnected();

    if (options?.delay != null) {
      // Delayed messages: batch add to sorted set
      const delayMs = durationToMs(options.delay);
      const readyAt = Date.now() + delayMs;
      
      const items = messages.map((msg) => ({
        score: readyAt,
        value: JSON.stringify({ id: crypto.randomUUID(), data: JSON.stringify(msg) }),
      }));
      
      await this.redis.zAdd(this.delayedKey, items);
      logger.debug("Enqueued delayed batch", { count: messages.length, readyAt });
    } else {
      // Immediate messages: batch add to stream
      const multi = this.redis.multi();
      
      for (const msg of messages) {
        multi.xAdd(
          this.streamKey,
          "*",
          { id: crypto.randomUUID(), data: JSON.stringify(msg) },
          { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } }
        );
      }
      
      await multi.exec();
      await this.redis.publish(this.channelKey, "new");
      
      logger.debug("Enqueued immediate batch", { count: messages.length });
    }
  }

  // ==========================================================================
  // MessageQueue Interface: listen
  // ==========================================================================

  /**
   * Start listening for messages.
   * 
   * IMPORTANT: This method returns a Promise that NEVER resolves unless
   * the signal is aborted. This is required by Fedify's MessageQueue interface.
   * 
   * @param handler - Function to call for each message
   * @param options - Optional settings including abort signal
   */
  async listen(
    handler: (message: unknown) => Promise<void> | void,
    options: MessageQueueListenOptions = {},
  ): Promise<void> {
    if (this.isListening) {
      throw new Error("Already listening");
    }
    
    await this.ensureConnected();
    this.isListening = true;

    const signal = options.signal;
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();

    // Cleanup function
    const cleanup = () => {
      this.isListening = false;
      for (const timeout of timeouts) clearTimeout(timeout);
      for (const interval of intervals) clearInterval(interval);
      timeouts.clear();
      intervals.clear();
    };

    // Register abort handler
    signal?.addEventListener("abort", cleanup);

    try {
      // Subscribe to notification channel
      await this.subRedis.subscribe(this.channelKey, () => {
        // When notified, poll will pick up the message
      });

      // Start delayed message mover
      const delayedInterval = setInterval(async () => {
        if (signal?.aborted) return;
        await this.moveDelayedToStream();
      }, this.delayedPollIntervalMs);
      intervals.add(delayedInterval);

      // Main processing loop
      while (!signal?.aborted) {
        try {
          // Step 1: Claim any idle messages from crashed workers
          await this.processClaimedMessages(handler, signal);
          
          // Step 2: Read new messages
          await this.processNewMessages(handler, signal);
          
          // Step 3: Move any ready delayed messages
          await this.moveDelayedToStream();
          
        } catch (err: any) {
          if (signal?.aborted) break;
          logger.error("Error in message processing loop", { error: err.message });
          
          // Wait before retrying to avoid tight error loops
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 1000);
            timeouts.add(timeout);
            signal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              resolve();
            }, { once: true });
          });
        }
      }
    } finally {
      cleanup();
      signal?.removeEventListener("abort", cleanup);
      
      try {
        await this.subRedis.unsubscribe(this.channelKey);
      } catch {
        // Ignore unsubscribe errors during shutdown
      }
    }
  }

  // ==========================================================================
  // Internal Processing Methods
  // ==========================================================================

  /**
   * Claim and process messages that have been idle too long (crashed workers).
   */
  private async processClaimedMessages(
    handler: (message: unknown) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;

    try {
      const claimed = await this.redis.xAutoClaim(
        this.streamKey,
        this.consumerGroup,
        this.consumerId,
        this.claimIdleTimeMs,
        "0-0",
        { COUNT: 10 }
      );

      if (claimed.messages && claimed.messages.length > 0) {
        for (const msg of claimed.messages) {
          if (signal?.aborted) break;
          await this.processMessage(msg, handler);
        }
      }
    } catch (err: any) {
      // NOGROUP means the group doesn't exist yet, which is fine
      if (!err.message?.includes("NOGROUP")) {
        throw err;
      }
    }
  }

  /**
   * Read and process new messages from the stream.
   */
  private async processNewMessages(
    handler: (message: unknown) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;

    const streams = await this.redis.xReadGroup(
      this.consumerGroup,
      this.consumerId,
      { key: this.streamKey, id: ">" },
      { COUNT: 10, BLOCK: this.blockTimeoutMs }
    );

    if (streams) {
      for (const stream of streams) {
        for (const msg of stream.messages) {
          if (signal?.aborted) break;
          await this.processMessage(msg, handler);
        }
      }
    }
  }

  /**
   * Process a single message and acknowledge it.
   */
  private async processMessage(
    msg: { id: string; message: Record<string, string> },
    handler: (message: unknown) => Promise<void> | void,
  ): Promise<void> {
    try {
      const data = msg.message?.data;
      if (data) {
        const message = JSON.parse(data);
        await handler(message);
      }
      
      // Acknowledge the message after successful processing
      await this.redis.xAck(this.streamKey, this.consumerGroup, msg.id);
      
    } catch (err: any) {
      // Don't acknowledge on error - Fedify will handle retries
      // The message will be reclaimed by XAUTOCLAIM after claimIdleTimeMs
      logger.error("Error processing message", { messageId: msg.id, error: err.message });
      throw err;
    }
  }

  /**
   * Move delayed messages that are ready to the main stream.
   */
  private async moveDelayedToStream(): Promise<void> {
    const now = Date.now();
    
    // Get messages that are ready (score <= now)
    const ready = await this.redis.zRangeByScore(this.delayedKey, 0, now, { LIMIT: { offset: 0, count: 100 } });
    
    if (ready.length === 0) return;

    const multi = this.redis.multi();
    
    for (const item of ready) {
      try {
        const { id, data } = JSON.parse(item);
        multi.xAdd(
          this.streamKey,
          "*",
          { id, data },
          { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } }
        );
        multi.zRem(this.delayedKey, item);
      } catch {
        // Skip malformed items
        multi.zRem(this.delayedKey, item);
      }
    }
    
    await multi.exec();
    
    if (ready.length > 0) {
      await this.redis.publish(this.channelKey, "delayed");
      logger.debug("Moved delayed messages to stream", { count: ready.length });
    }
  }

  // ==========================================================================
  // Disposable Interface
  // ==========================================================================

  [Symbol.dispose](): void {
    this.isListening = false;
    
    Promise.all([
      this.redis.quit().catch(() => {}),
      this.subRedis.quit().catch(() => {}),
    ]).then(() => {
      this.isConnected = false;
    });
  }

  /**
   * Gracefully disconnect from Redis.
   */
  async disconnect(): Promise<void> {
    this.isListening = false;
    
    await Promise.all([
      this.redis.quit().catch(() => {}),
      this.subRedis.quit().catch(() => {}),
    ]);
    
    this.isConnected = false;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert a Temporal.Duration or DurationLike to milliseconds.
 */
function durationToMs(duration: Temporal.Duration | Temporal.DurationLike): number {
  if (duration instanceof Temporal.Duration) {
    return duration.total("millisecond");
  }
  return Temporal.Duration.from(duration).total("millisecond");
}

// ============================================================================
// Export Default Configuration Helper
// ============================================================================

export function createRedisStreamsMessageQueue(
  options?: RedisStreamsQueueOptions
): RedisStreamsMessageQueue {
  return new RedisStreamsMessageQueue(options);
}
