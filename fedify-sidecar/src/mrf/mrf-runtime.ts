/**
 * V6 Message Rejection Filter (MRF) Runtime
 * 
 * Implements pre-accept MRF processing for inbound activities.
 * MRF policies run BEFORE activities are accepted into ActivityPods.
 * Rejected activities are published to ap.mrf.rejected.v1 for audit.
 * 
 * This is a critical Tier 2 component that was missing from earlier versions.
 */

import { Kafka, Producer } from 'kafkajs';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface MrfPolicy {
  name: string;
  enabled: boolean;
  priority: number;
  evaluate(activity: any, context: MrfContext): Promise<MrfResult>;
}

export interface MrfContext {
  actorUri: string;
  remoteIp: string;
  receivedAt: number;
}

export interface MrfResult {
  allowed: boolean;
  reason?: string;
  policy?: string;
  metadata?: Record<string, any>;
}

export interface MrfRejectionEvent {
  jobId: string;
  activity: any;
  actor: string;
  reason: string;
  policy: string;
  timestamp: number;
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
 * Reject activities from blocked domains
 */
export class BlockedDomainPolicy implements MrfPolicy {
  name = 'blocked-domain';
  enabled = true;
  priority = 100;
  
  private blockedDomains: Set<string>;

  constructor(blockedDomains: string[] = []) {
    this.blockedDomains = new Set(blockedDomains);
  }

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    try {
      const actorUrl = new URL(context.actorUri);
      const domain = actorUrl.hostname;

      if (this.blockedDomains.has(domain)) {
        return {
          allowed: false,
          reason: `Domain ${domain} is blocked`,
          policy: this.name,
        };
      }

      return { allowed: true };
    } catch (err) {
      logger.error('Error in blocked-domain policy:', err);
      return { allowed: true }; // Fail open on error
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
 * Reject activities with suspicious patterns
 */
export class SuspiciousActivityPolicy implements MrfPolicy {
  name = 'suspicious-activity';
  enabled = true;
  priority = 90;

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    // Check for activities with extremely large payloads
    const activityJson = JSON.stringify(activity);
    if (activityJson.length > 10 * 1024 * 1024) { // 10MB
      return {
        allowed: false,
        reason: 'Activity payload too large',
        policy: this.name,
      };
    }

    // Check for activities with suspicious object types
    const suspiciousTypes = ['Tombstone', 'Undo'];
    if (suspiciousTypes.includes(activity.type)) {
      // These require additional validation
      if (!activity.object || !activity.object.id) {
        return {
          allowed: false,
          reason: `${activity.type} activity missing required object`,
          policy: this.name,
        };
      }
    }

    return { allowed: true };
  }
}

/**
 * Reject activities with invalid signatures
 */
export class SignatureValidationPolicy implements MrfPolicy {
  name = 'signature-validation';
  enabled = true;
  priority = 110; // Run first

  async evaluate(activity: any, context: MrfContext): Promise<MrfResult> {
    // Signature validation is handled by the inbound worker
    // This policy is a placeholder for explicit MRF-level validation
    return { allowed: true };
  }
}

// ============================================================================
// MRF Runtime
// ============================================================================

export class MrfRuntime {
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
    logger.info('MRF runtime connected to Kafka');
  }

  /**
   * Disconnect from Kafka
   */
  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    logger.info('MRF runtime disconnected from Kafka');
  }

  /**
   * Process activity through MRF policies
   */
  async processActivity(
    activity: any,
    context: MrfContext
  ): Promise<{ allowed: boolean; reason?: string; policy?: string }> {
    for (const policy of this.policies) {
      if (!policy.enabled) continue;

      try {
        const result = await policy.evaluate(activity, context);

        if (!result.allowed) {
          logger.info(`Activity rejected by ${policy.name}: ${result.reason}`);
          
          // Emit rejection event
          await this.emitRejection({
            jobId: `${activity.id}-${Date.now()}`,
            activity,
            actor: context.actorUri,
            reason: result.reason || 'Unknown',
            policy: policy.name,
            timestamp: Date.now(),
          });

          return {
            allowed: false,
            reason: result.reason,
            policy: policy.name,
          };
        }
      } catch (err) {
        logger.error(`Error in MRF policy ${policy.name}:`, err);
        // Fail open on policy error
      }
    }

    return { allowed: true };
  }

  /**
   * Emit rejection event to audit topic
   */
  private async emitRejection(event: MrfRejectionEvent): Promise<void> {
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
   * Get health status
   */
  async health(): Promise<{ status: string; connected: boolean }> {
    try {
      await this.kafka.admin().connect();
      await this.kafka.admin().disconnect();
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
  const blockedDomains = (process.env.MRF_BLOCKED_DOMAINS || '').split(',').filter(Boolean);
  
  return {
    brokers: (process.env.REDPANDA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.REDPANDA_CLIENT_ID || 'fedify-mrf',
    rejectionTopic: process.env.MRF_REJECTION_TOPIC || 'ap.mrf.rejected.v1',
    policies: [
      new SignatureValidationPolicy(),
      new BlockedDomainPolicy(blockedDomains),
      new SuspiciousActivityPolicy(),
    ],
  };
}
