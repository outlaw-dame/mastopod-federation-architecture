/**
 * V6 Inbound Worker
 * 
 * Processes inbound HTTP requests with the following pipeline:
 * 1. HTTP signature verification
 * 2. Pre-accept MRF processing (NEW in V6)
 * 3. Actor document fetching and caching
 * 4. Forward verified activities to ActivityPods
 * 5. Publish public activities to ap.stream2.remote-public.v1
 * 
 * This replaces the earlier inbound-worker.ts with proper MRF integration.
 */

import { request } from 'undici';
import { createVerify, createHash } from 'node:crypto';
import { Kafka, Producer } from 'kafkajs';
import { DeliveryStateManager } from '../queue/delivery-state.js';
import { MrfRuntime } from '../mrf/mrf-runtime.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface V6InboundWorkerConfig {
  concurrency: number;
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs: number;
  userAgent: string;
  redpandaBrokers: string[];
  redisUrl: string;
}

export interface InboundRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  remoteIp: string;
  receivedAt: number;
}

export interface VerificationResult {
  valid: boolean;
  actorUri?: string;
  error?: string;
}

export interface Stream2Event {
  activityId: string;
  activityType: string;
  actor: string;
  object?: any;
  published: string;
  to?: string[];
  cc?: string[];
  content?: string;
  inReplyTo?: string;
  verifiedAt: number;
  remoteIp: string;
  timestamp: number;
}

// ============================================================================
// V6 Inbound Worker
// ============================================================================

export class V6InboundWorker {
  private deliveryState: DeliveryStateManager;
  private mrf: MrfRuntime;
  private producer: Producer;
  private config: V6InboundWorkerConfig;
  private isRunning = false;
  private activeJobs = 0;
  private actorCache: Map<string, { data: any; expiresAt: number }> = new Map();

  constructor(
    deliveryState: DeliveryStateManager,
    mrf: MrfRuntime,
    producer: Producer,
    config: V6InboundWorkerConfig
  ) {
    this.deliveryState = deliveryState;
    this.mrf = mrf;
    this.producer = producer;
    this.config = config;
  }

  /**
   * Process inbound HTTP request
   */
  async processRequest(inboundRequest: InboundRequest): Promise<{
    statusCode: number;
    body: any;
  }> {
    this.activeJobs++;

    try {
      // Parse activity from body
      let activity: any;
      try {
        activity = JSON.parse(inboundRequest.body.toString());
      } catch (err) {
        logger.warn('Failed to parse activity JSON', { error: err.message });
        return {
          statusCode: 400,
          body: { error: 'invalid_json' },
        };
      }

      // Step 1: Verify HTTP signature
      const verificationResult = await this.verifyHttpSignature(inboundRequest);
      if (!verificationResult.valid) {
        logger.warn('HTTP signature verification failed', {
          error: verificationResult.error,
        });
        return {
          statusCode: 401,
          body: { error: 'invalid_signature' },
        };
      }

      const actorUri = verificationResult.actorUri!;

      // Step 2: Pre-accept MRF processing (NEW in V6)
      const mrfContext = {
        actorUri,
        remoteIp: inboundRequest.remoteIp,
        receivedAt: inboundRequest.receivedAt,
      };

      const mrfResult = await this.mrf.processActivity(activity, mrfContext);
      if (!mrfResult.allowed) {
        logger.info('Activity rejected by MRF', {
          actor: actorUri,
          reason: mrfResult.reason,
          policy: mrfResult.policy,
        });
        return {
          statusCode: 202, // Accept but don't process
          body: { status: 'rejected_by_mrf' },
        };
      }

      // Step 3: Fetch and cache actor document
      const actorDoc = await this.getActorDocument(actorUri);
      if (!actorDoc) {
        logger.warn('Failed to fetch actor document', { actorUri });
        return {
          statusCode: 401,
          body: { error: 'actor_not_found' },
        };
      }

      // Step 4: Forward verified activity to ActivityPods
      const forwardResult = await this.forwardToActivityPods(
        activity,
        actorUri,
        inboundRequest
      );

      if (!forwardResult.success) {
        logger.error('Failed to forward to ActivityPods', {
          error: forwardResult.error,
        });
        return {
          statusCode: forwardResult.permanent ? 400 : 500,
          body: { error: 'forward_failed' },
        };
      }

      // Step 5: Publish public activities to Stream2
      if (this.isPublicActivity(activity)) {
        await this.publishToStream2(activity, actorUri, inboundRequest);
      }

      return {
        statusCode: 202,
        body: { status: 'accepted' },
      };
    } catch (err) {
      logger.error('Unhandled error in inbound processing', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        statusCode: 500,
        body: { error: 'server_error' },
      };
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * Verify HTTP signature (Cavage-style)
   */
  private async verifyHttpSignature(
    request: InboundRequest
  ): Promise<VerificationResult> {
    try {
      const signatureHeader = request.headers['signature'];
      if (!signatureHeader) {
        return { valid: false, error: 'missing_signature_header' };
      }

      // Parse signature header
      const signatureParams = this.parseSignatureHeader(signatureHeader);
      if (!signatureParams.keyId || !signatureParams.signature) {
        return { valid: false, error: 'invalid_signature_header' };
      }

      // Extract actor URI from keyId (format: https://actor#key)
      const actorUri = signatureParams.keyId.split('#')[0];

      // Fetch actor document
      const actorDoc = await this.getActorDocument(actorUri);
      if (!actorDoc || !actorDoc.publicKeyPem) {
        return { valid: false, error: 'actor_not_found' };
      }

      // Build signing string
      const signingString = this.buildSigningString(
        request,
        signatureParams.headers
      );

      // Verify signature
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signingString);
      const isValid = verifier.verify(actorDoc.publicKeyPem, signatureParams.signature, 'base64');

      if (!isValid) {
        return { valid: false, error: 'signature_verification_failed' };
      }

      return { valid: true, actorUri };
    } catch (err) {
      logger.error('Error verifying HTTP signature:', err);
      return { valid: false, error: 'verification_error' };
    }
  }

  /**
   * Parse Cavage signature header
   */
  private parseSignatureHeader(header: string): Record<string, any> {
    const params: Record<string, string> = {};
    const regex = /(\w+)="([^"]*)"/g;
    let match;

    while ((match = regex.exec(header)) !== null) {
      params[match[1]] = match[2];
    }

    if (params.signature) {
      params.signature = Buffer.from(params.signature, 'base64');
    }

    if (params.headers) {
      params.headers = params.headers.split(' ');
    }

    return params;
  }

  /**
   * Build signing string for verification
   */
  private buildSigningString(
    request: InboundRequest,
    headersToSign: string[]
  ): string {
    const lines: string[] = [];

    for (const header of headersToSign) {
      if (header === '(request-target)') {
        lines.push(
          `(request-target): ${request.method.toLowerCase()} ${new URL(request.url).pathname}`
        );
      } else {
        const value = request.headers[header.toLowerCase()];
        if (value) {
          lines.push(`${header.toLowerCase()}: ${value}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Get actor document (with caching)
   */
  private async getActorDocument(actorUri: string): Promise<any | null> {
    // Check cache
    const cached = this.actorCache.get(actorUri);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
      const response = await request(actorUri, {
        method: 'GET',
        headers: {
          Accept: 'application/activity+json',
          'User-Agent': this.config.userAgent,
        },
        timeout: this.config.requestTimeoutMs,
      });

      if (response.statusCode !== 200) {
        return null;
      }

      const body = await response.body.text();
      const actorDoc = JSON.parse(body);

      // Cache for 1 hour
      this.actorCache.set(actorUri, {
        data: actorDoc,
        expiresAt: Date.now() + 3600000,
      });

      return actorDoc;
    } catch (err) {
      logger.error('Failed to fetch actor document', { actorUri, error: err });
      return null;
    }
  }

  /**
   * Forward verified activity to ActivityPods
   */
  private async forwardToActivityPods(
    activity: any,
    actorUri: string,
    request: InboundRequest
  ): Promise<{ success: boolean; permanent?: boolean; error?: string }> {
    try {
      const response = await request(
        `${this.config.activityPodsUrl}/api/internal/inbox/receive`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.activityPodsToken}`,
          },
          body: JSON.stringify({
            targetInbox: `${this.config.activityPodsUrl}/inbox`,
            activity,
            verifiedActorUri: actorUri,
            receivedAt: request.receivedAt,
            remoteIp: request.remoteIp,
          }),
          timeout: this.config.requestTimeoutMs,
        }
      );

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { success: true };
      }

      const body = await response.body.text();

      // 4xx errors are permanent (except 429)
      if (
        response.statusCode >= 400 &&
        response.statusCode < 500 &&
        response.statusCode !== 429
      ) {
        return {
          success: false,
          permanent: true,
          error: `ActivityPods returned ${response.statusCode}: ${body}`,
        };
      }

      // 5xx and 429 are transient
      return {
        success: false,
        permanent: false,
        error: `ActivityPods returned ${response.statusCode}: ${body}`,
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
   * Check if activity is public
   */
  private isPublicActivity(activity: any): boolean {
    const publicUri = 'https://www.w3.org/ns/activitystreams#Public';
    const to = activity.to || [];
    const cc = activity.cc || [];

    return (
      to.includes(publicUri) ||
      to.includes('Public') ||
      cc.includes(publicUri) ||
      cc.includes('Public')
    );
  }

  /**
   * Publish to Stream2 (remote public activities)
   */
  private async publishToStream2(
    activity: any,
    actorUri: string,
    request: InboundRequest
  ): Promise<void> {
    try {
      const event: Stream2Event = {
        activityId: activity.id,
        activityType: activity.type,
        actor: actorUri,
        object: activity.object,
        published: activity.published,
        to: activity.to,
        cc: activity.cc,
        content: activity.content,
        inReplyTo: activity.inReplyTo,
        verifiedAt: Date.now(),
        remoteIp: request.remoteIp,
        timestamp: Date.now(),
      };

      await this.producer.send({
        topic: 'ap.stream2.remote-public.v1',
        messages: [
          {
            key: activity.id,
            value: JSON.stringify(event),
            timestamp: Date.now().toString(),
          },
        ],
      });
    } catch (err) {
      logger.error('Failed to publish to Stream2:', err);
    }
  }
}

/**
 * Create default inbound worker configuration
 */
export function createDefaultInboundWorkerConfig(): V6InboundWorkerConfig {
  return {
    concurrency: parseInt(process.env.INBOUND_CONCURRENCY || '10', 10),
    activityPodsUrl: process.env.ACTIVITYPODS_URL || 'http://localhost:3000',
    activityPodsToken: process.env.ACTIVITYPODS_TOKEN || '',
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),
    userAgent: process.env.USER_AGENT || 'Fedify-Sidecar/v6',
    redpandaBrokers: (process.env.REDPANDA_BROKERS || 'localhost:9092').split(','),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  };
}
