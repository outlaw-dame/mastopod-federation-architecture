/**
 * Inbound Worker
 * 
 * Processes inbound envelopes from the Redis Streams queue.
 * Verifies HTTP signatures, validates activities, and forwards to ActivityPods.
 * Also publishes public activities to Stream2 (RedPanda).
 * 
 * Key principles:
 * - HTTP signature verification before processing
 * - Actor document fetching with caching
 * - Forward verified activities to ActivityPods
 * - Publish public activities to Stream2
 */

import { request } from "undici";
import { createVerify, createHash } from "node:crypto";
import { 
  RedisStreamsQueue, 
  InboundEnvelope,
} from "../queue/redis-streams-queue.js";
import { RedPandaProducer } from "../streams/redpanda-producer.js";
import { logger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface InboundWorkerConfig {
  concurrency: number;
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs: number;
  userAgent: string;
}

export interface VerificationResult {
  valid: boolean;
  actorUri?: string;
  error?: string;
}

// ============================================================================
// Inbound Worker
// ============================================================================

export class InboundWorker {
  private queue: RedisStreamsQueue;
  private redpanda: RedPandaProducer;
  private config: InboundWorkerConfig;
  private isRunning = false;
  private activeJobs = 0;

  constructor(
    queue: RedisStreamsQueue,
    redpanda: RedPandaProducer,
    config: InboundWorkerConfig
  ) {
    this.queue = queue;
    this.redpanda = redpanda;
    this.config = config;
  }

  /**
   * Start the worker loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Inbound worker started", { concurrency: this.config.concurrency });

    for await (const { messageId, envelope } of this.queue.consumeInbound()) {
      if (!this.isRunning) break;

      // Respect concurrency limit
      while (this.activeJobs >= this.config.concurrency) {
        await this.sleep(100);
      }

      // Process envelope (don't await - run concurrently)
      this.processEnvelope(messageId, envelope).catch(err => {
        logger.error("Unhandled error in envelope processing", { 
          envelopeId: envelope.envelopeId, 
          error: err.message 
        });
      });
    }
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
    
    logger.info("Inbound worker stopped", { remainingJobs: this.activeJobs });
  }

  /**
   * Process a single inbound envelope
   */
  private async processEnvelope(messageId: string, envelope: InboundEnvelope): Promise<void> {
    this.activeJobs++;
    
    try {
      // Step 1: Parse the activity
      let activity: any;
      try {
        activity = JSON.parse(envelope.body);
      } catch (err) {
        await this.queue.ack("inbound", messageId);
        await this.queue.moveToDlq("inbound", envelope, "Invalid JSON body");
        logger.warn("Invalid JSON in inbound envelope", { envelopeId: envelope.envelopeId });
        return;
      }

      // Step 2: Verify HTTP signature
      const verification = await this.verifySignature(envelope);
      
      if (!verification.valid) {
        await this.queue.ack("inbound", messageId);
        await this.queue.moveToDlq("inbound", envelope, `Signature verification failed: ${verification.error}`);
        logger.warn("Signature verification failed", { 
          envelopeId: envelope.envelopeId, 
          error: verification.error 
        });
        return;
      }

      // Step 3: Basic activity validation
      if (!activity.type || !activity.actor) {
        await this.queue.ack("inbound", messageId);
        await this.queue.moveToDlq("inbound", envelope, "Missing required activity fields");
        logger.warn("Invalid activity structure", { envelopeId: envelope.envelopeId });
        return;
      }

      // Step 4: Check if activity is public
      const isPublic = this.isPublicActivity(activity);

      // Step 5: Forward to ActivityPods
      const forwardResult = await this.forwardToActivityPods(envelope, activity, verification.actorUri!);
      
      if (!forwardResult.success) {
        // Forwarding failed - requeue or DLQ based on error type
        await this.queue.ack("inbound", messageId);
        if (forwardResult.permanent) {
          await this.queue.moveToDlq("inbound", envelope, forwardResult.error || "Forward failed");
        } else {
          // Requeue for retry (simple retry - could be more sophisticated)
          await this.queue.enqueueInbound(envelope);
        }
        logger.warn("Failed to forward to ActivityPods", { 
          envelopeId: envelope.envelopeId, 
          error: forwardResult.error 
        });
        return;
      }

      // Step 6: Publish public activities to Stream2
      if (isPublic) {
        try {
          await this.redpanda.publishToStream2({
            activity,
            actorUri: verification.actorUri!,
            receivedAt: envelope.receivedAt,
            path: envelope.path,
          });
          logger.debug("Published to Stream2", { 
            activityId: activity.id, 
            type: activity.type 
          });
        } catch (err: any) {
          // Log but don't fail - Stream2 is best-effort
          logger.error("Failed to publish to Stream2", { 
            envelopeId: envelope.envelopeId, 
            error: err.message 
          });
        }
      }

      // Step 7: Ack the message
      await this.queue.ack("inbound", messageId);
      logger.info("Inbound activity processed", { 
        envelopeId: envelope.envelopeId,
        activityId: activity.id,
        type: activity.type,
        actor: verification.actorUri,
        isPublic,
      });

    } catch (err: any) {
      logger.error("Error processing inbound envelope", { 
        envelopeId: envelope.envelopeId, 
        error: err.message 
      });
      await this.queue.ack("inbound", messageId);
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * Verify HTTP signature on an inbound envelope
   */
  private async verifySignature(envelope: InboundEnvelope): Promise<VerificationResult> {
    try {
      const signatureHeader = envelope.headers["signature"];
      if (!signatureHeader) {
        return { valid: false, error: "Missing Signature header" };
      }

      // Parse signature header
      const sigParams = this.parseSignatureHeader(signatureHeader);
      if (!sigParams.keyId || !sigParams.signature || !sigParams.headers) {
        return { valid: false, error: "Invalid Signature header format" };
      }

      // Fetch actor document to get public key
      const actorDoc = await this.fetchActorDocument(sigParams.keyId);
      if (!actorDoc) {
        return { valid: false, error: "Could not fetch actor document" };
      }

      const publicKeyPem = actorDoc.publicKey?.publicKeyPem;
      if (!publicKeyPem) {
        return { valid: false, error: "Actor has no public key" };
      }

      // Verify digest if present
      const digestHeader = envelope.headers["digest"];
      if (digestHeader) {
        const expectedDigest = `SHA-256=${createHash("sha256").update(envelope.body).digest("base64")}`;
        if (digestHeader !== expectedDigest) {
          return { valid: false, error: "Digest mismatch" };
        }
      }

      // Build signing string
      const signingString = this.buildSigningString(envelope, sigParams.headers.split(" "));

      // Verify signature
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signingString);
      const isValid = verifier.verify(publicKeyPem, sigParams.signature, "base64");

      if (!isValid) {
        return { valid: false, error: "Signature verification failed" };
      }

      // Extract actor URI from keyId
      const actorUri = sigParams.keyId.split("#")[0];

      return { valid: true, actorUri };

    } catch (err: any) {
      return { valid: false, error: `Verification error: ${err.message}` };
    }
  }

  /**
   * Parse HTTP Signature header
   */
  private parseSignatureHeader(header: string): Record<string, string> {
    const params: Record<string, string> = {};
    const regex = /(\w+)="([^"]+)"/g;
    let match;
    while ((match = regex.exec(header)) !== null) {
      params[match[1]] = match[2];
    }
    return params;
  }

  /**
   * Build signing string for verification
   */
  private buildSigningString(envelope: InboundEnvelope, signedHeaders: string[]): string {
    const lines: string[] = [];
    
    for (const header of signedHeaders) {
      const h = header.toLowerCase();
      if (h === "(request-target)") {
        lines.push(`(request-target): ${envelope.method.toLowerCase()} ${envelope.path}`);
      } else if (h === "host") {
        lines.push(`host: ${envelope.headers["host"]}`);
      } else if (h === "date") {
        lines.push(`date: ${envelope.headers["date"]}`);
      } else if (h === "digest") {
        lines.push(`digest: ${envelope.headers["digest"]}`);
      } else if (h === "content-type") {
        lines.push(`content-type: ${envelope.headers["content-type"]}`);
      } else if (envelope.headers[h]) {
        lines.push(`${h}: ${envelope.headers[h]}`);
      }
    }
    
    return lines.join("\n");
  }

  /**
   * Fetch actor document with caching
   */
  private async fetchActorDocument(keyId: string): Promise<any | null> {
    // Extract actor URI from keyId (e.g., "https://example.com/users/alice#main-key" -> "https://example.com/users/alice")
    const actorUri = keyId.split("#")[0];

    // Check cache first
    const cached = await this.queue.getCachedActorDoc(actorUri);
    if (cached) {
      return cached;
    }

    try {
      const response = await request(actorUri, {
        method: "GET",
        headers: {
          "accept": "application/activity+json, application/ld+json",
          "user-agent": this.config.userAgent,
        },
        bodyTimeout: this.config.requestTimeoutMs,
        headersTimeout: this.config.requestTimeoutMs,
      });

      if (response.statusCode !== 200) {
        logger.warn("Failed to fetch actor document", { actorUri, statusCode: response.statusCode });
        return null;
      }

      const doc = await response.body.json() as any;

      // Cache the document
      await this.queue.cacheActorDoc(actorUri, doc);

      return doc;

    } catch (err: any) {
      logger.error("Error fetching actor document", { actorUri, error: err.message });
      return null;
    }
  }

  /**
   * Check if an activity is public
   */
  private isPublicActivity(activity: any): boolean {
    const publicAddresses = [
      "https://www.w3.org/ns/activitystreams#Public",
      "as:Public",
      "Public",
    ];

    const checkAddressing = (field: any): boolean => {
      if (!field) return false;
      const addresses = Array.isArray(field) ? field : [field];
      return addresses.some(addr => publicAddresses.includes(addr));
    };

    return checkAddressing(activity.to) || checkAddressing(activity.cc);
  }

  /**
   * Forward activity to ActivityPods
   */
  private async forwardToActivityPods(
    envelope: InboundEnvelope, 
    activity: any,
    verifiedActorUri: string
  ): Promise<{ success: boolean; permanent?: boolean; error?: string }> {
    try {
      // Determine target inbox from path
      // Path format: /users/{username}/inbox or /{username}/inbox
      const targetInbox = `${this.config.activityPodsUrl}${envelope.path}`;

      const response = await request(`${this.config.activityPodsUrl}/api/internal/inbox/receive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.config.activityPodsToken}`,
        },
        body: JSON.stringify({
          targetInbox,
          activity,
          verifiedActorUri,
          receivedAt: envelope.receivedAt,
          remoteIp: envelope.remoteIp,
        }),
        bodyTimeout: this.config.requestTimeoutMs,
        headersTimeout: this.config.requestTimeoutMs,
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        await response.body.text();  // Consume body
        return { success: true };
      }

      const body = await response.body.text();
      
      // 4xx errors are permanent (except 429)
      if (response.statusCode >= 400 && response.statusCode < 500 && response.statusCode !== 429) {
        return { 
          success: false, 
          permanent: true, 
          error: `ActivityPods returned ${response.statusCode}: ${body}` 
        };
      }

      // 5xx and 429 are transient
      return { 
        success: false, 
        permanent: false, 
        error: `ActivityPods returned ${response.statusCode}: ${body}` 
      };

    } catch (err: any) {
      return { 
        success: false, 
        permanent: false, 
        error: `Network error: ${err.message}` 
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createInboundWorker(
  queue: RedisStreamsQueue,
  redpanda: RedPandaProducer,
  overrides?: Partial<InboundWorkerConfig>
): InboundWorker {
  const config: InboundWorkerConfig = {
    concurrency: parseInt(process.env.INBOUND_CONCURRENCY || "32", 10),
    activityPodsUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
    activityPodsToken: process.env.ACTIVITYPODS_TOKEN || "",
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10),
    userAgent: process.env.USER_AGENT || "Fedify-Sidecar/1.0 (ActivityPods)",
    ...overrides,
  };

  return new InboundWorker(queue, redpanda, config);
}
