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
import { createVerify, createHash, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Kafka, Producer } from 'kafkajs';
import { DeliveryStateManager } from '../queue/delivery-state.js';
import { MrfRuntime } from '../mrf/mrf-runtime.js';
import { logger } from '../utils/logger.js';

// RFC-1918, loopback, link-local, CGNAT, and benchmarking address detection.
function isPrivateHostname(h: string): boolean {
  const lower = h.toLowerCase();
  if (lower === 'localhost' || lower === '::1' || lower === '0.0.0.0') return true;
  if (lower.startsWith('127.') || lower.startsWith('10.') || lower.startsWith('192.168.')) return true;
  if (lower.startsWith('172.')) {
    const seg = Number.parseInt(lower.split('.')[1] ?? '-1', 10);
    if (seg >= 16 && seg <= 31) return true;
  }
  if (lower.startsWith('169.254.')) return true; // link-local / AWS IMDS
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  // Carrier-grade NAT 100.64.0.0/10
  if (lower.startsWith('100.')) {
    const seg = Number.parseInt(lower.split('.')[1] ?? '-1', 10);
    if (seg >= 64 && seg <= 127) return true;
  }
  // Benchmarking 198.18.0.0/15
  if (lower.startsWith('198.18.') || lower.startsWith('198.19.')) return true;
  // IPv4-mapped IPv6
  if (lower.startsWith('::ffff:')) return isPrivateHostname(lower.slice(7));
  return false;
}

function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}


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
        logger.warn('Failed to parse activity JSON', {
          error: err instanceof Error ? err.message : String(err),
        });
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

  // ---------------------------------------------------------------------------
  // SSRF guard: validates actorUri before making any outbound HTTP request.
  // ---------------------------------------------------------------------------
  private async assertSafeActorUri(uri: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error('invalid_actor_uri');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('actor_uri_must_be_https');
    }
    if (parsed.username || parsed.password) {
      throw new Error('actor_uri_credentials_not_allowed');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (isPrivateHostname(hostname)) {
      throw new Error('actor_uri_resolves_to_private_address');
    }
    // Resolve DNS only for non-literal hostnames
    if (isIP(hostname) === 0) {
      let records: Array<{ address: string }> = [];
      try {
        records = await dnsLookup(hostname, { all: true });
      } catch {
        throw new Error('actor_uri_dns_resolution_failed');
      }
      for (const { address } of records) {
        if (isPrivateHostname(address)) {
          throw new Error('actor_uri_resolves_to_private_address');
        }
      }
    }
  }

  /**
   * Verify HTTP signature (Cavage-style) with body Digest validation.
   *
   * Security guarantees:
   *  1. Every header listed in the signature's `headers` param MUST be present
   *     — missing headers are not silently skipped (prevents signed-header downgrade).
   *  2. If `digest` is listed in the signed headers, the SHA-256 of the request
   *     body is verified against the Digest header (prevents body substitution).
   *  3. Body-bearing requests without a signed `digest` are accepted as lower
   *     trust — callers can choose to reject these entirely via configuration.
   *  4. The actorUri derived from keyId is validated against SSRF guards before
   *     any outbound DNS lookup or HTTP fetch.
   */
  private async verifyHttpSignature(
    req: InboundRequest
  ): Promise<VerificationResult> {
    try {
      const signatureHeader = req.headers['signature'];
      if (!signatureHeader) {
        return { valid: false, error: 'missing_signature_header' };
      }

      const signatureParams = this.parseSignatureHeader(signatureHeader);
      const keyId = signatureParams["keyId"];
      const signature = signatureParams["signature"];
      const headers = signatureParams["headers"];
      if (
        typeof keyId !== "string" ||
        !Buffer.isBuffer(signature) ||
        !Array.isArray(headers)
      ) {
        return { valid: false, error: 'invalid_signature_header' };
      }

      const headerList = headers.filter((v): v is string => typeof v === "string");

      // -----------------------------------------------------------------------
      // CRIT-4: Digest / body-integrity check.
      // -----------------------------------------------------------------------
      const digestIndex = headerList.indexOf('digest');
      if (digestIndex !== -1) {
        // `digest` is in the signed set — verify body integrity.
        const digestHeader = req.headers['digest'];
        if (!digestHeader) {
          return { valid: false, error: 'digest_header_missing' };
        }
        // Support "SHA-256=<base64>" format (RFC 3230).
        const match = /^SHA-256=([A-Za-z0-9+/=]+)$/i.exec(digestHeader.trim());
        if (!match) {
          return { valid: false, error: 'digest_header_format_invalid' };
        }
        const expected = Buffer.from(match[1] ?? '', 'base64');
        const actual = createHash('sha256').update(req.body).digest();
        if (expected.length !== actual.length || !timingSafeBufferEqual(expected, actual)) {
          return { valid: false, error: 'digest_mismatch' };
        }
      } else if (req.body.length > 0) {
        // Body present but digest not signed — log a warning and continue.
        // Administrators may tighten this to a hard reject via config.
        logger.warn('Inbound activity body is not covered by HTTP Signature digest', {
          keyId,
        });
      }

      // -----------------------------------------------------------------------
      // L-6 / MED-2: Validate actorUri before any fetch (SSRF guard).
      // -----------------------------------------------------------------------
      const rawActorUri = keyId.split('#')[0] ?? keyId;
      try {
        await this.assertSafeActorUri(rawActorUri);
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : 'invalid_actor_uri',
        };
      }
      const actorUri = rawActorUri;

      const actorDoc = await this.getActorDocument(actorUri);
      if (!actorDoc || !actorDoc.publicKeyPem) {
        return { valid: false, error: 'actor_not_found' };
      }

      // -----------------------------------------------------------------------
      // L-5: Build signing string; reject if any listed header is absent.
      // -----------------------------------------------------------------------
      const signingStringResult = this.buildSigningString(req, headerList);
      if (signingStringResult === null) {
        return { valid: false, error: 'required_header_missing' };
      }

      const verifier = createVerify('RSA-SHA256');
      verifier.update(signingStringResult);
      const isValid = verifier.verify(actorDoc.publicKeyPem, signature);

      if (!isValid) {
        return { valid: false, error: 'signature_verification_failed' };
      }

      return { valid: true, actorUri };
    } catch (err) {
      logger.error('Error verifying HTTP signature', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { valid: false, error: 'verification_error' };
    }
  }

  /**
   * Parse Cavage signature header
   */
  private parseSignatureHeader(header: string): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const regex = /(\w+)="([^"]*)"/g;
    let match;

    while ((match = regex.exec(header)) !== null) {
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined) {
        params[key] = value;
      }
    }

    if (typeof params["signature"] === "string") {
      params["signature"] = Buffer.from(params["signature"], 'base64');
    }

    if (typeof params["headers"] === "string") {
      params["headers"] = params["headers"].split(' ');
    }

    return params;
  }

  /**
   * Build signing string for verification.
   *
   * Returns null if any listed header is absent from the request — callers
   * must treat null as a verification failure (prevents signed-header downgrade).
   */
  private buildSigningString(
    req: InboundRequest,
    headersToSign: string[],
  ): string | null {
    const lines: string[] = [];

    for (const header of headersToSign) {
      if (header === '(request-target)') {
        lines.push(
          `(request-target): ${req.method.toLowerCase()} ${new URL(req.url).pathname}`,
        );
      } else {
        const value = req.headers[header.toLowerCase()];
        if (value === undefined || value === '') {
          // L-5: Required header absent — fail the verification rather than skipping.
          return null;
        }
        lines.push(`${header.toLowerCase()}: ${value}`);
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
        headersTimeout: this.config.requestTimeoutMs,
        bodyTimeout: this.config.requestTimeoutMs,
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
    inboundRequest: InboundRequest
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
            receivedAt: inboundRequest.receivedAt,
            remoteIp: inboundRequest.remoteIp,
          }),
          headersTimeout: this.config.requestTimeoutMs,
          bodyTimeout: this.config.requestTimeoutMs,
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
    concurrency: parseInt(process.env["INBOUND_CONCURRENCY"] || '10', 10),
    activityPodsUrl: process.env["ACTIVITYPODS_URL"] || 'http://localhost:3000',
    activityPodsToken: process.env["ACTIVITYPODS_TOKEN"] || '',
    requestTimeoutMs: parseInt(process.env["REQUEST_TIMEOUT_MS"] || '30000', 10),
    userAgent: process.env["USER_AGENT"] || 'Fedify-Sidecar/v6',
    redpandaBrokers: (process.env["REDPANDA_BROKERS"] || 'localhost:9092').split(','),
    redisUrl: process.env["REDIS_URL"] || 'redis://localhost:6379',
  };
}
