/**
 * V6 MRF Runtime - Aligned with ActivityPub MRF Specification
 * 
 * Reference: https://aumetra.xyz/posts/activitypub-mrf/
 * 
 * This implementation follows the ActivityPub MRF specification with:
 * - Direction context (incoming/outgoing)
 * - Outcome union (accept, reject)
 * - Error handling (continue, fatal)
 * - Activity modification support
 * - Rejection audit trail
 * 
 * Phase 1: In-process TypeScript policies (MVP)
 * Phase 2: WebAssembly-based extensible policies (future)
 */

import { Kafka, Producer } from 'kafkajs';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types - Aligned with ActivityPub MRF Spec
// ============================================================================

export enum MrfDirection {
  Incoming = 'incoming',
  Outgoing = 'outgoing',
}

export enum MrfOutcome {
  Accept = 'accept',
  Reject = 'reject',
}

export interface MrfResult {
  outcome: MrfOutcome;
  activity?: any; // Modified activity if accepted
  reason?: string; // Rejection reason
  policy?: string; // Policy that made the decision
  error?: {
    code: 'error-continue' | 'error-reject';
    message: string;
  };
}

export interface MrfContext {
  direction: MrfDirection;
  actorUri: string;
  remoteIp?: string;
  receivedAt?: number;
}

export interface MrfPolicy {
  name: string;
  enabled: boolean;
  priority: number;
  direction: MrfDirection | 'both';
  evaluate(activity: any, context: MrfContext): Promise<MrfResult>;
}

export interface MrfRuntimeConfig {
  brokers: string[];
  clientId: string;
  rejectionTopic: string;
  policies: MrfPolicy[];
}

// ============================================================================
// Built-in MRF Policies
// ============================================================================

/**
 * Signature Validation Policy (Incoming Only)
 * 
 * Verifies HTTP signatures before accepting activities.
 * This is a placeholder - actual verification happens in inbound-worker.
 */
export class SignatureValidationPolicy implements MrfPolicy {
  name = 'signature-validation';
  enabled = true;
  priority = 110; // Run first
  direction: MrfDirection = MrfDirection.Incoming;

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    // Signature validation is handled by the inbound worker before MRF
    // This policy is a placeholder for explicit MRF-level validation
    return { outcome: MrfOutcome.Accept };
  }
}

/**
 * Blocked Domain Policy (Both Directions)
 * 
 * Rejects activities from/to blocked domains.
 */
export class BlockedDomainPolicy implements MrfPolicy {
  name = 'blocked-domain';
  enabled = true;
  priority = 100;
  direction = 'both';

  private blockedDomains: Set<string>;

  constructor(blockedDomains: string[] = []) {
    this.blockedDomains = new Set(blockedDomains);
  }

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    try {
      const domain = this.extractDomain(context.actorUri);

      if (this.blockedDomains.has(domain)) {
        return {
          outcome: MrfOutcome.Reject,
          reason: `Domain ${domain} is blocked`,
          policy: this.name,
        };
      }

      return { outcome: MrfOutcome.Accept };
    } catch (err) {
      return {
        outcome: MrfOutcome.Accept,
        error: {
          code: 'error-continue',
          message: `Error in blocked-domain policy: ${err}`,
        },
      };
    }
  }

  private extractDomain(uri: string): string {
    try {
      return new URL(uri).hostname;
    } catch {
      return '';
    }
  }

  addBlockedDomain(domain: string): void {
    this.blockedDomains.add(domain);
  }

  removeBlockedDomain(domain: string): void {
    this.blockedDomains.delete(domain);
  }
}

/**
 * Suspicious Activity Policy (Incoming Only)
 * 
 * Detects malformed or oversized activities.
 */
export class SuspiciousActivityPolicy implements MrfPolicy {
  name = 'suspicious-activity';
  enabled = true;
  priority = 90;
  direction: MrfDirection = MrfDirection.Incoming;

  private maxPayloadSize = 10 * 1024 * 1024; // 10MB

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    // Check for activities with extremely large payloads
    const activityJson = JSON.stringify(activity);
    if (activityJson.length > this.maxPayloadSize) {
      return {
        outcome: MrfOutcome.Reject,
        reason: `Activity payload exceeds ${this.maxPayloadSize} bytes`,
        policy: this.name,
      };
    }

    // Check for activities with suspicious object types
    const suspiciousTypes = ['Tombstone', 'Undo'];
    if (suspiciousTypes.includes(activity.type)) {
      // These require additional validation
      if (!activity.object || !activity.object.id) {
        return {
          outcome: MrfOutcome.Reject,
          reason: `${activity.type} activity missing required object`,
          policy: this.name,
        };
      }
    }

    // Check for missing required fields
    if (!activity.id || !activity.type || !activity.actor) {
      return {
        outcome: MrfOutcome.Reject,
        reason: 'Activity missing required fields (id, type, actor)',
        policy: this.name,
      };
    }

    return { outcome: MrfOutcome.Accept };
  }

  setMaxPayloadSize(bytes: number): void {
    this.maxPayloadSize = bytes;
  }
}

/**
 * Content Filter Policy (Incoming Only)
 * 
 * Rejects activities based on content patterns.
 */
export class ContentFilterPolicy implements MrfPolicy {
  name = 'content-filter';
  enabled = false; // Disabled by default
  priority = 80;
  direction: MrfDirection = MrfDirection.Incoming;

  private patterns: RegExp[] = [];

  constructor(patterns: string[] = []) {
    this.patterns = patterns.map((p) => new RegExp(p, 'i'));
  }

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    const content = activity.content || '';

    for (const pattern of this.patterns) {
      if (pattern.test(content)) {
        return {
          outcome: MrfOutcome.Reject,
          reason: `Content matches blocked pattern: ${pattern.source}`,
          policy: this.name,
        };
      }
    }

    return { outcome: MrfOutcome.Accept };
  }

  addPattern(pattern: string): void {
    this.patterns.push(new RegExp(pattern, 'i'));
  }

  removePattern(pattern: string): void {
    this.patterns = this.patterns.filter((p) => p.source !== pattern);
  }
}

/**
 * Rate Limiting Policy (Outgoing Only)
 * 
 * Limits delivery rate per domain.
 * (Actual rate limiting is in DeliveryStateManager)
 */
export class RateLimitingPolicy implements MrfPolicy {
  name = 'rate-limiting';
  enabled = true;
  priority = 70;
  direction: MrfDirection = MrfDirection.Outgoing;

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    // Rate limiting is handled by DeliveryStateManager
    // This policy is a placeholder for explicit MRF-level validation
    return { outcome: MrfOutcome.Accept };
  }
}

// ============================================================================
// MRF Runtime
// ============================================================================

export class V6MrfRuntime {
  private kafka: Kafka;
  private producer: Producer;
  private config: MrfRuntimeConfig;
  private policies: MrfPolicy[] = [];

  constructor(config: MrfRuntimeConfig) {
    this.config = config;
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
    });
    this.producer = this.kafka.producer();
    this.policies = config.policies.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Connect to Kafka
   */
  async connect(): Promise<void> {
    await this.producer.connect();
    logger.info('V6 MRF runtime connected to Kafka');
  }

  /**
   * Disconnect from Kafka
   */
  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    logger.info('V6 MRF runtime disconnected from Kafka');
  }

  /**
   * Process activity through MRF policies
   * 
   * Follows ActivityPub MRF spec:
   * - Direction context (incoming/outgoing)
   * - Outcome union (accept, reject)
   * - Error handling (continue, fatal)
   * - Activity modification support
   */
  async processActivity(
    activity: any,
    context: MrfContext
  ): Promise<MrfResult> {
    let currentActivity = activity;

    for (const policy of this.policies) {
      // Skip policies not applicable to this direction
      if (
        policy.direction !== 'both' &&
        policy.direction !== context.direction
      ) {
        continue;
      }

      if (!policy.enabled) continue;

      try {
        const result = await policy.evaluate(currentActivity, context);

        // Handle errors
        if (result.error) {
          logger.warn(`MRF policy ${policy.name} returned error`, {
            code: result.error.code,
            message: result.error.message,
          });

          // Fatal error - stop processing
          if (result.error.code === 'error-reject') {
            return {
              outcome: MrfOutcome.Reject,
              reason: result.error.message,
              policy: policy.name,
            };
          }

          // Continue on non-fatal errors
          continue;
        }

        // Handle rejection
        if (result.outcome === MrfOutcome.Reject) {
          logger.info(`Activity rejected by ${policy.name}`, {
            reason: result.reason,
            direction: context.direction,
          });

          // Emit rejection event
          await this.emitRejection({
            jobId: `${activity.id}-${Date.now()}`,
            activity,
            actor: context.actorUri,
            reason: result.reason || 'Unknown',
            policy: policy.name,
            timestamp: Date.now(),
          });

          return result;
        }

        // Handle activity modification
        if (result.activity) {
          currentActivity = result.activity;
          logger.debug(`Activity modified by ${policy.name}`);
        }
      } catch (err) {
        logger.error(`Error in MRF policy ${policy.name}:`, err);
        // Fail open on policy error
      }
    }

    return { outcome: MrfOutcome.Accept, activity: currentActivity };
  }

  /**
   * Emit rejection event to audit topic
   */
  private async emitRejection(event: any): Promise<void> {
    try {
      await this.producer.send({
        topic: this.config.rejectionTopic,
        messages: [
          {
            key: event.jobId,
            value: JSON.stringify(event),
            timestamp: event.timestamp.toString(),
          },
        ],
      });
    } catch (err) {
      logger.error('Failed to emit MRF rejection event:', err);
    }
  }

  /**
   * Add a policy to the runtime
   */
  addPolicy(policy: MrfPolicy): void {
    this.policies.push(policy);
    this.policies.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a policy by name
   */
  removePolicy(policyName: string): void {
    this.policies = this.policies.filter((p) => p.name !== policyName);
  }

  /**
   * Enable/disable a policy
   */
  setPolicyEnabled(policyName: string, enabled: boolean): void {
    const policy = this.policies.find((p) => p.name === policyName);
    if (policy) {
      policy.enabled = enabled;
    }
  }

  /**
   * Get all policies
   */
  getPolicies(): MrfPolicy[] {
    return this.policies;
  }

  /**
   * Get policy by name
   */
  getPolicy(policyName: string): MrfPolicy | undefined {
    return this.policies.find((p) => p.name === policyName);
  }

  /**
   * Get health status
   */
  async health(): Promise<{ status: string; connected: boolean }> {
    try {
      await this.producer.admin().connect();
      await this.producer.admin().disconnect();
      return { status: 'healthy', connected: true };
    } catch (err) {
      return { status: 'unhealthy', connected: false };
    }
  }
}

/**
 * Create default MRF runtime configuration
 */
export function createDefaultMrfConfig(): MrfRuntimeConfig {
  const blockedDomains = (process.env.MRF_BLOCKED_DOMAINS || '')
    .split(',')
    .filter(Boolean);

  const policies: MrfPolicy[] = [];

  // Add enabled policies
  if (process.env.MRF_POLICY_SIGNATURE_VALIDATION !== 'false') {
    policies.push(new SignatureValidationPolicy());
  }

  if (process.env.MRF_POLICY_BLOCKED_DOMAIN !== 'false') {
    policies.push(new BlockedDomainPolicy(blockedDomains));
  }

  if (process.env.MRF_POLICY_SUSPICIOUS_ACTIVITY !== 'false') {
    policies.push(new SuspiciousActivityPolicy());
  }

  if (process.env.MRF_POLICY_CONTENT_FILTER !== 'false') {
    const patterns = (process.env.MRF_CONTENT_FILTER_PATTERNS || '')
      .split(',')
      .filter(Boolean);
    const contentFilter = new ContentFilterPolicy(patterns);
    if (patterns.length > 0) {
      contentFilter.enabled = true;
    }
    policies.push(contentFilter);
  }

  if (process.env.MRF_POLICY_RATE_LIMITING !== 'false') {
    policies.push(new RateLimitingPolicy());
  }

  return {
    brokers: (process.env.REDPANDA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.REDPANDA_CLIENT_ID || 'fedify-mrf-v6',
    rejectionTopic: process.env.MRF_REJECTION_TOPIC || 'ap.mrf.rejected.v1',
    policies,
  };
}
