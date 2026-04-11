/**
 * V6 Delivery State Management (Redis)
 * 
 * This module manages delivery state, idempotency, rate limiting, and concurrency
 * for outbound federation. It does NOT implement a work queue - that comes from
 * RedPanda's ap.outbound.v1 event log.
 * 
 * Redis is used ONLY for:
 * - Delivery state tracking (pending, delivered, failed)
 * - Idempotency (prevent duplicate deliveries)
 * - Domain rate limiting
 * - Domain concurrency slot allocation
 * - Actor document caching
 * - MRF rejection tracking
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface DeliveryStateConfig {
  redisUrl: string;
  maxConcurrentPerDomain: number;
  idempotencyTtlMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxPerWindow: number;
  actorCacheTtlMs: number;
}

export interface DeliveryState {
  jobId: string;
  targetInbox: string;
  domain: string;
  status: 'pending' | 'delivered' | 'failed' | 'rejected';
  attempts: number;
  lastAttemptAt?: number;
  nextRetryAt?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DomainRateLimit {
  domain: string;
  requestCount: number;
  windowStart: number;
}

// ============================================================================
// Delivery State Manager
// ============================================================================

export class DeliveryStateManager {
  private redis: RedisClientType;
  private config: DeliveryStateConfig;
  private isConnected = false;

  constructor(config: DeliveryStateConfig) {
    this.config = config;
    this.redis = createClient({
      url: config.redisUrl,
    });

    this.redis.on('error', (err) => {
      logger.error('Redis error:', err);
    });

    this.redis.on('connect', () => {
      logger.info('Connected to Redis for delivery state management');
      this.isConnected = true;
    });

    this.redis.on('disconnect', () => {
      logger.warn('Disconnected from Redis');
      this.isConnected = false;
    });
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.redis.connect();
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.redis.disconnect();
  }

  /**
   * Store delivery state
   */
  async setDeliveryState(state: DeliveryState): Promise<void> {
    const key = `ap:delivery:${state.jobId}`;
    const ttl = 7 * 24 * 60 * 60; // 7 days
    
    await this.redis.setEx(
      key,
      ttl,
      JSON.stringify({
        ...state,
        updatedAt: Date.now(),
      })
    );
  }

  /**
   * Get delivery state
   */
  async getDeliveryState(jobId: string): Promise<DeliveryState | null> {
    const key = `ap:delivery:${jobId}`;
    const data = await this.redis.get(key);
    
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Check if delivery is idempotent (already delivered)
   */
  async checkIdempotency(jobId: string): Promise<boolean> {
    const state = await this.getDeliveryState(jobId);
    
    if (!state) return false;
    
    // Already delivered or rejected
    return state.status === 'delivered' || state.status === 'rejected';
  }

  /**
   * Record idempotency (mark as delivered)
   */
  async recordIdempotency(jobId: string): Promise<void> {
    const key = `ap:idempotency:${jobId}`;
    const ttl = Math.ceil(this.config.idempotencyTtlMs / 1000);
    
    await this.redis.setEx(key, ttl, '1');
  }

  /**
   * Check domain rate limit
   */
  async checkDomainRateLimit(domain: string): Promise<boolean> {
    const key = `ap:ratelimit:${domain}`;
    const window = Math.ceil(this.config.rateLimitWindowMs / 1000);
    
    const count = await this.redis.incr(key);
    
    if (count === 1) {
      // First request in window, set expiry
      await this.redis.expire(key, window);
    }
    
    return count <= this.config.rateLimitMaxPerWindow;
  }

  /**
   * Get current rate limit count for domain
   */
  async getRateLimitCount(domain: string): Promise<number> {
    const key = `ap:ratelimit:${domain}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Acquire concurrency slot for domain
   */
  async acquireDomainSlot(domain: string): Promise<boolean> {
    const key = `ap:domain:slots:${domain}`;
    const current = await this.redis.get(key);
    const count = current ? parseInt(current, 10) : 0;
    
    if (count >= this.config.maxConcurrentPerDomain) {
      return false;
    }
    
    await this.redis.incr(key);
    // Set expiry to prevent stale slots
    await this.redis.expire(key, 3600); // 1 hour
    
    return true;
  }

  /**
   * Release concurrency slot for domain
   */
  async releaseDomainSlot(domain: string): Promise<void> {
    const key = `ap:domain:slots:${domain}`;
    await this.redis.decr(key);
  }

  /**
   * Cache actor document
   */
  async cacheActorDocument(actorUri: string, document: any): Promise<void> {
    const key = `ap:actor:${actorUri}`;
    const ttl = Math.ceil(this.config.actorCacheTtlMs / 1000);
    
    await this.redis.setEx(key, ttl, JSON.stringify(document));
  }

  /**
   * Get cached actor document
   */
  async getCachedActorDocument(actorUri: string): Promise<any | null> {
    const key = `ap:actor:${actorUri}`;
    const data = await this.redis.get(key);
    
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Invalidate actor document cache
   */
  async invalidateActorCache(actorUri: string): Promise<void> {
    const key = `ap:actor:${actorUri}`;
    await this.redis.del(key);
  }

  /**
   * Check if domain is blocked
   */
  async isDomainBlocked(domain: string): Promise<boolean> {
    const key = `ap:domain:blocked:${domain}`;
    const blocked = await this.redis.get(key);
    return blocked === '1';
  }

  /**
   * Block a domain
   */
  async blockDomain(domain: string, ttlMs?: number): Promise<void> {
    const key = `ap:domain:blocked:${domain}`;
    const ttl = ttlMs ? Math.ceil(ttlMs / 1000) : 7 * 24 * 60 * 60; // 7 days default
    
    await this.redis.setEx(key, ttl, '1');
  }

  /**
   * Unblock a domain
   */
  async unblockDomain(domain: string): Promise<void> {
    const key = `ap:domain:blocked:${domain}`;
    await this.redis.del(key);
  }

  /**
   * Track MRF rejection
   */
  async trackMrfRejection(jobId: string, reason: string): Promise<void> {
    const key = `ap:mrf:rejected:${jobId}`;
    const ttl = 7 * 24 * 60 * 60; // 7 days
    
    await this.redis.setEx(
      key,
      ttl,
      JSON.stringify({
        reason,
        rejectedAt: Date.now(),
      })
    );
  }

  /**
   * Get MRF rejection reason
   */
  async getMrfRejectionReason(jobId: string): Promise<string | null> {
    const key = `ap:mrf:rejected:${jobId}`;
    const data = await this.redis.get(key);
    
    if (!data) return null;
    
    const rejection = JSON.parse(data);
    return rejection.reason;
  }

  /**
   * Get health status
   */
  async health(): Promise<{ status: string; connected: boolean }> {
    try {
      await this.redis.ping();
      return { status: 'healthy', connected: true };
    } catch (err) {
      return { status: 'unhealthy', connected: false };
    }
  }
}

/**
 * Create default delivery state configuration
 */
export function createDefaultConfig(): DeliveryStateConfig {
  return {
    redisUrl: process.env["REDIS_URL"] || 'redis://localhost:6379',
    maxConcurrentPerDomain: parseInt(process.env["MAX_CONCURRENT_PER_DOMAIN"] || '5', 10),
    idempotencyTtlMs: parseInt(process.env["IDEMPOTENCY_TTL_MS"] || '86400000', 10), // 24h
    rateLimitWindowMs: parseInt(process.env["RATE_LIMIT_WINDOW_MS"] || '3600000', 10), // 1h
    rateLimitMaxPerWindow: parseInt(process.env["RATE_LIMIT_MAX_PER_WINDOW"] || '1000', 10),
    actorCacheTtlMs: parseInt(process.env["ACTOR_CACHE_TTL_MS"] || '3600000', 10), // 1h
  };
}
