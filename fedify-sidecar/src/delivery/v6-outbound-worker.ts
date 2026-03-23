/**
 * V6 Outbound Worker
 * 
 * Consumes outbound delivery readiness events from RedPanda ap.outbound.v1
 * and uses Redis for delivery state tracking.
 * 
 * Pipeline:
 * 1. Consume ap.outbound.v1 events from RedPanda (append-only event log)
 * 2. Check idempotency in Redis
 * 3. Check domain rate limiting
 * 4. Acquire domain concurrency slot
 * 5. Request HTTP signature from ActivityPods
 * 6. Deliver to remote inbox
 * 7. Track delivery state in Redis
 * 8. Publish to ap.stream1.local-public.v1 if public
 * 
 * This is the canonical V6 outbound path.
 */

import { Kafka, Consumer, EachBatchPayload } from 'kafkajs';
import { request } from 'undici';
import { DeliveryStateManager } from '../queue/delivery-state.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface V6OutboundWorkerConfig {
  concurrency: number;
  brokers: string[];
  clientId: string;
  groupId: string;
  outboundTopic: string;
  stream1Topic: string;
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs: number;
  userAgent: string;
  maxRetries: number;
  retryDelayMs: number;
}

export interface OutboundEvent {
  jobId: string;
  actor: string;
  activity: any;
  recipients: string[];
  sharedInbox?: string;
  timestamp: number;
}

export interface SigningRequest {
  requestId: string;
  actorUri: string;
  method: 'POST';
  targetUrl: string;
  headers: Record<string, string>;
  body: string;
}

export interface SigningResult {
  requestId: string;
  ok: boolean;
  signedHeaders?: Record<string, string>;
  error?: { code: string; message: string };
}

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  permanent?: boolean;
  error?: string;
}

// ============================================================================
// V6 Outbound Worker
// ============================================================================

export class V6OutboundWorker {
  private kafka: Kafka;
  private consumer: Consumer;
  private deliveryState: DeliveryStateManager;
  private config: V6OutboundWorkerConfig;
  private isRunning = false;
  private activeJobs = 0;

  constructor(
    deliveryState: DeliveryStateManager,
    config: V6OutboundWorkerConfig
  ) {
    this.deliveryState = deliveryState;
    this.config = config;

    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
    });

    this.consumer = this.kafka.consumer({
      groupId: config.groupId,
    });
  }

  /**
   * Start the worker
   */
  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.config.outboundTopic });

    this.isRunning = true;
    logger.info('V6 outbound worker started', {
      topic: this.config.outboundTopic,
      concurrency: this.config.concurrency,
    });

    await this.consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: this.handleBatch.bind(this),
    });
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    const timeout = Date.now() + 30000;
    while (this.activeJobs > 0 && Date.now() < timeout) {
      await this.sleep(100);
    }

    await this.consumer.disconnect();
    logger.info('V6 outbound worker stopped', { remainingJobs: this.activeJobs });
  }

  /**
   * Handle batch of messages from RedPanda
   */
  private async handleBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat } = payload;

    for (const message of batch.messages) {
      if (!this.isRunning) break;

      // Respect concurrency limit
      while (this.activeJobs >= this.config.concurrency) {
        await this.sleep(100);
      }

      // Process message (don't await - run concurrently)
      this.processMessage(message).catch((err) => {
        logger.error('Unhandled error in message processing', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Heartbeat to prevent rebalancing
      await heartbeat();
    }

    // Resolve offset after processing batch
    resolveOffset(batch.messages[batch.messages.length - 1].offset);
  }

  /**
   * Process outbound event
   */
  private async processMessage(message: any): Promise<void> {
    this.activeJobs++;

    try {
      const event: OutboundEvent = JSON.parse(message.value.toString());

      logger.debug('Processing outbound event', {
        jobId: event.jobId,
        actor: event.actor,
        recipientCount: event.recipients.length,
      });

      // Check idempotency
      const isDuplicate = await this.deliveryState.checkIdempotency(event.jobId);
      if (isDuplicate) {
        logger.debug('Skipping duplicate delivery', { jobId: event.jobId });
        return;
      }

      // Check domain blocking
      const domain = new URL(event.recipients[0]).hostname;
      const isBlocked = await this.deliveryState.isDomainBlocked(domain);
      if (isBlocked) {
        logger.info('Domain is blocked', { domain, jobId: event.jobId });
        await this.deliveryState.trackMrfRejection(
          event.jobId,
          `Domain ${domain} is blocked`
        );
        return;
      }

      // Check rate limiting
      const withinLimit = await this.deliveryState.checkDomainRateLimit(domain);
      if (!withinLimit) {
        logger.info('Domain rate limit exceeded', { domain, jobId: event.jobId });
        // Retry later
        return;
      }

      // Acquire concurrency slot
      const slotAcquired = await this.deliveryState.acquireDomainSlot(domain);
      if (!slotAcquired) {
        logger.debug('No concurrency slots available', { domain });
        // Retry later
        return;
      }

      try {
        // Deliver to all recipients
        for (const recipient of event.recipients) {
          await this.deliverToInbox(event, recipient);
        }

        // Mark as delivered
        await this.deliveryState.recordIdempotency(event.jobId);
        logger.info('Delivery completed', {
          jobId: event.jobId,
          recipientCount: event.recipients.length,
        });
      } finally {
        // Release concurrency slot
        await this.deliveryState.releaseDomainSlot(domain);
      }
    } catch (err) {
      logger.error('Error processing outbound event', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * Deliver activity to remote inbox
   */
  private async deliverToInbox(event: OutboundEvent, inbox: string): Promise<void> {
    try {
      // Request HTTP signature from ActivityPods
      const signingRequest: SigningRequest = {
        requestId: `${event.jobId}-${Date.now()}`,
        actorUri: event.actor,
        method: 'POST',
        targetUrl: inbox,
        headers: {
          'Content-Type': 'application/activity+json',
          Date: new Date().toUTCString(),
          Host: new URL(inbox).hostname,
        },
        body: JSON.stringify(event.activity),
      };

      const signingResult = await this.requestSignature(signingRequest);
      if (!signingResult.ok) {
        logger.error('Failed to get signature', {
          jobId: event.jobId,
          error: signingResult.error?.message,
        });
        return;
      }

      // Deliver with signature
      const deliveryResult = await this.deliverWithSignature(
        inbox,
        event.activity,
        signingResult.signedHeaders!
      );

      if (!deliveryResult.success) {
        logger.error('Delivery failed', {
          jobId: event.jobId,
          inbox,
          error: deliveryResult.error,
          statusCode: deliveryResult.statusCode,
        });

        // Block domain on permanent failures
        if (deliveryResult.permanent) {
          const domain = new URL(inbox).hostname;
          await this.deliveryState.blockDomain(domain, 24 * 60 * 60 * 1000); // 24h
        }
      } else {
        logger.info('Delivery successful', {
          jobId: event.jobId,
          inbox,
        });
      }
    } catch (err) {
      logger.error('Error delivering to inbox', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Request HTTP signature from ActivityPods
   */
  private async requestSignature(
    signingRequest: SigningRequest
  ): Promise<SigningResult> {
    try {
      const response = await request(
        `${this.config.activityPodsUrl}/api/internal/signatures/batch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.activityPodsToken}`,
          },
          body: JSON.stringify({
            requests: [signingRequest],
          }),
          timeout: this.config.requestTimeoutMs,
        }
      );

      if (response.statusCode !== 200) {
        return {
          requestId: signingRequest.requestId,
          ok: false,
          error: {
            code: 'SIGNING_SERVICE_ERROR',
            message: `Signing service returned ${response.statusCode}`,
          },
        };
      }

      const body = await response.body.json() as any;
      const result = body.results[0];

      return {
        requestId: signingRequest.requestId,
        ok: result.ok,
        signedHeaders: result.signedHeaders,
        error: result.error,
      };
    } catch (err) {
      return {
        requestId: signingRequest.requestId,
        ok: false,
        error: {
          code: 'SIGNING_REQUEST_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Deliver activity with HTTP signature
   */
  private async deliverWithSignature(
    inbox: string,
    activity: any,
    signedHeaders: Record<string, string>
  ): Promise<DeliveryResult> {
    try {
      const response = await request(inbox, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json',
          ...signedHeaders,
        },
        body: JSON.stringify(activity),
        timeout: this.config.requestTimeoutMs,
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { success: true, statusCode: response.statusCode };
      }

      // 4xx errors are permanent (except 429)
      if (
        response.statusCode >= 400 &&
        response.statusCode < 500 &&
        response.statusCode !== 429
      ) {
        const body = await response.body.text();
        return {
          success: false,
          statusCode: response.statusCode,
          permanent: true,
          error: body,
        };
      }

      // 5xx and 429 are transient
      const body = await response.body.text();
      return {
        success: false,
        statusCode: response.statusCode,
        permanent: false,
        error: body,
      };
    } catch (err) {
      return {
        success: false,
        permanent: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create default outbound worker configuration
 */
export function createDefaultOutboundWorkerConfig(): V6OutboundWorkerConfig {
  return {
    concurrency: parseInt(process.env.OUTBOUND_CONCURRENCY || '20', 10),
    brokers: (process.env.REDPANDA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.REDPANDA_CLIENT_ID || 'fedify-outbound-v6',
    groupId: process.env.OUTBOUND_CONSUMER_GROUP || 'fedify-outbound-v6',
    outboundTopic: process.env.OUTBOUND_TOPIC || 'ap.outbound.v1',
    stream1Topic: process.env.STREAM1_TOPIC || 'ap.stream1.local-public.v1',
    activityPodsUrl: process.env.ACTIVITYPODS_URL || 'http://localhost:3000',
    activityPodsToken: process.env.ACTIVITYPODS_TOKEN || '',
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),
    userAgent: process.env.USER_AGENT || 'Fedify-Sidecar/v6',
    maxRetries: parseInt(process.env.MAX_RETRIES || '10', 10),
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '60000', 10),
  };
}
