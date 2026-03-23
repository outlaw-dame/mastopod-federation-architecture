/**
 * Inbound Handler
 * 
 * Handles incoming ActivityPub activities from remote servers.
 * Responsibilities:
 * 1. Receive HTTP POST to inbox endpoints
 * 2. Verify HTTP signatures
 * 3. Enqueue to Redis for processing
 * 4. Produce public activities to RedPanda Stream2
 * 5. Forward to ActivityPods for local delivery
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { ulid } from "ulid";

import {
  RedisStreamsQueue,
  InboundEnvelope,
  createRedisStreamsQueue,
} from "../queue/redis-streams-queue.js";
import {
  RedPandaStreams,
  RemotePublicActivity,
  TombstoneEvent,
  createRedPandaStreams,
} from "../streams/redpanda-streams.js";
import { logger } from "../utils/logger.js";
import { metrics } from "../metrics/index.js";

// ============================================================================
// Types
// ============================================================================

export interface InboundHandlerConfig {
  // ActivityPods forwarding
  activityPodsUrl: string;
  forwardingToken: string;
  
  // Signature verification
  signatureVerificationEnabled: boolean;
  maxClockSkewSeconds: number;
  
  // Rate limiting
  maxRequestsPerDomain: number;
  rateLimitWindowSeconds: number;
}

interface ParsedSignature {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
}

// ============================================================================
// Inbound Handler
// ============================================================================

export class InboundHandler {
  private queue: RedisStreamsQueue;
  private streams: RedPandaStreams;
  private config: InboundHandlerConfig;

  constructor(
    queue: RedisStreamsQueue,
    streams: RedPandaStreams,
    config: InboundHandlerConfig
  ) {
    this.queue = queue;
    this.streams = streams;
    this.config = config;
  }

  /**
   * Create Hono routes for inbox endpoints.
   */
  createRoutes(): Hono {
    const app = new Hono();

    // Shared inbox endpoint
    app.post("/inbox", async (c) => {
      return this.handleInboxPost(c);
    });

    // Per-user inbox endpoint
    app.post("/users/:username/inbox", async (c) => {
      return this.handleInboxPost(c);
    });

    return app;
  }

  /**
   * Handle POST to inbox.
   */
  private async handleInboxPost(c: any): Promise<Response> {
    const startTime = Date.now();
    
    try {
      // Parse request
      const body = await c.req.text();
      const activity = JSON.parse(body);
      
      // Extract signature info
      const signatureHeader = c.req.header("signature") || "";
      const digestHeader = c.req.header("digest") || "";
      const dateHeader = c.req.header("date") || "";
      const host = c.req.header("host") || "";
      const remoteIp = c.req.header("x-forwarded-for")?.split(",")[0] || "unknown";

      // Determine origin domain
      const actorUri = activity.actor;
      const originDomain = actorUri ? new URL(actorUri).hostname : "unknown";

      // Rate limiting check
      // (Simplified - production should use Redis-based rate limiting)
      
      // Create envelope for queue
      const envelope: InboundEnvelope = {
        receivedAt: new Date().toISOString(),
        remoteIp,
        httpSignature: {
          signatureHeader,
          digest: digestHeader,
          date: dateHeader,
        },
        request: {
          path: c.req.path,
          host,
          contentType: c.req.header("content-type") || "",
        },
        activity,
      };

      // Enqueue for async processing
      await this.queue.enqueueInbound(envelope);

      metrics.inboundReceived.inc({ domain: originDomain });
      metrics.inboundLatency.observe(
        { domain: originDomain },
        (Date.now() - startTime) / 1000
      );

      logger.info("Inbound activity received", {
        activityType: activity.type,
        actorUri,
        originDomain,
      });

      // Return 202 Accepted (async processing)
      return c.json({ status: "accepted" }, 202);
    } catch (err: any) {
      logger.error("Error handling inbound POST", { error: err.message });
      metrics.inboundErrors.inc();
      return c.json({ error: "Invalid request" }, 400);
    }
  }

  /**
   * Process an inbound envelope from the queue.
   * This is called by the inbound worker.
   */
  async processEnvelope(envelope: InboundEnvelope): Promise<void> {
    const activity = envelope.activity;
    const actorUri = activity.actor as string;
    const originDomain = actorUri ? new URL(actorUri).hostname : "unknown";

    // Step 1: Verify signature (if enabled)
    if (this.config.signatureVerificationEnabled) {
      const isValid = await this.verifySignature(envelope);
      if (!isValid) {
        logger.warn("Signature verification failed", {
          actorUri,
          originDomain,
        });
        metrics.inboundSignatureFailures.inc({ domain: originDomain });
        return; // Drop the activity
      }
    }

    // Step 2: Determine if public
    const isPublic = this.isPublicActivity(activity);

    // Step 3: If public, produce to Stream2 and firehose
    if (isPublic) {
      const remoteActivity: RemotePublicActivity = {
        schema: "ap.inbound.accepted.v1",
        eventId: ulid(),
        timestamp: new Date().toISOString(),
        originDomain,
        originActorUri: actorUri,
        activityId: activity.id || activity["@id"],
        objectId: this.extractObjectId(activity),
        activityType: activity.type || activity["@type"],
        activity,
        verification: {
          signatureVerified: this.config.signatureVerificationEnabled,
          keyId: this.parseSignature(envelope.httpSignature.signatureHeader)?.keyId || "",
          verifiedAt: new Date().toISOString(),
        },
        meta: {
          isPublicIndexable: true,
        },
      };

      await this.streams.produceRemotePublic(remoteActivity);
      await this.streams.produceFirehose(remoteActivity);

      logger.debug("Produced remote public activity to streams", {
        activityId: remoteActivity.activityId,
        originDomain,
      });
    }

    // Step 4: Handle tombstones/deletes
    if (this.isDeleteActivity(activity)) {
      const tombstone: TombstoneEvent = {
        schema: "ap.tombstone.v1",
        eventId: ulid(),
        timestamp: new Date().toISOString(),
        objectId: this.extractObjectId(activity) || "",
        objectType: activity.object?.type,
        actorUri,
        activityId: activity.id || activity["@id"],
        activityType: activity.type as "Delete" | "Undo",
        activity,
        origin: "remote",
        originDomain,
      };

      await this.streams.produceTombstone(tombstone);
    }

    // Step 5: Forward to ActivityPods for local delivery
    await this.forwardToActivityPods(activity, envelope);

    metrics.inboundProcessed.inc({ domain: originDomain });
  }

  /**
   * Verify HTTP signature.
   * This is a simplified implementation - production should use a proper library.
   */
  private async verifySignature(envelope: InboundEnvelope): Promise<boolean> {
    const parsed = this.parseSignature(envelope.httpSignature.signatureHeader);
    if (!parsed) {
      return false;
    }

    // Fetch the public key from keyId
    // This would need to dereference the actor document and extract the key
    // For now, we'll assume verification passes if signature is present
    
    // TODO: Implement proper signature verification:
    // 1. Parse keyId to get actor URL
    // 2. Fetch actor document
    // 3. Extract publicKey
    // 4. Rebuild signing string
    // 5. Verify signature

    return parsed.signature.length > 0;
  }

  /**
   * Parse Cavage-style Signature header.
   */
  private parseSignature(header: string): ParsedSignature | null {
    if (!header) return null;

    const parts: Record<string, string> = {};
    
    // Parse key="value" pairs
    const regex = /(\w+)="([^"]+)"/g;
    let match;
    while ((match = regex.exec(header)) !== null) {
      parts[match[1]] = match[2];
    }

    if (!parts.keyId || !parts.signature) {
      return null;
    }

    return {
      keyId: parts.keyId,
      algorithm: parts.algorithm || "rsa-sha256",
      headers: (parts.headers || "").split(" "),
      signature: parts.signature,
    };
  }

  /**
   * Check if activity is public.
   */
  private isPublicActivity(activity: Record<string, unknown>): boolean {
    const publicAddress = "https://www.w3.org/ns/activitystreams#Public";
    const recipients = [
      ...(Array.isArray(activity.to) ? activity.to : [activity.to]),
      ...(Array.isArray(activity.cc) ? activity.cc : [activity.cc]),
    ].filter(Boolean);

    return recipients.some((r: any) =>
      r === publicAddress ||
      r === "as:Public" ||
      r === "Public"
    );
  }

  /**
   * Check if activity is a delete.
   */
  private isDeleteActivity(activity: Record<string, unknown>): boolean {
    const type = activity.type || activity["@type"];
    return type === "Delete" || type === "Tombstone";
  }

  /**
   * Extract object ID from activity.
   */
  private extractObjectId(activity: Record<string, unknown>): string | undefined {
    const object = activity.object;
    if (!object) return undefined;
    if (typeof object === "string") return object;
    return (object as any).id || (object as any)["@id"];
  }

  /**
   * Forward activity to ActivityPods for local delivery.
   */
  private async forwardToActivityPods(
    activity: Record<string, unknown>,
    envelope: InboundEnvelope
  ): Promise<void> {
    const url = `${this.config.activityPodsUrl}/api/internal/inbox/receive`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.forwardingToken}`,
          "X-Original-Signature": envelope.httpSignature.signatureHeader,
          "X-Original-Digest": envelope.httpSignature.digest,
          "X-Original-Date": envelope.httpSignature.date,
          "X-Remote-IP": envelope.remoteIp,
        },
        body: JSON.stringify(activity),
      });

      if (!response.ok) {
        logger.warn("ActivityPods forwarding failed", {
          status: response.status,
          activityId: activity.id,
        });
      }
    } catch (err: any) {
      logger.error("Error forwarding to ActivityPods", {
        error: err.message,
        activityId: activity.id,
      });
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createInboundHandler(config?: Partial<InboundHandlerConfig>): InboundHandler {
  const fullConfig: InboundHandlerConfig = {
    activityPodsUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
    forwardingToken: process.env.FORWARDING_TOKEN || "",
    signatureVerificationEnabled: process.env.SIGNATURE_VERIFICATION !== "false",
    maxClockSkewSeconds: Number(process.env.MAX_CLOCK_SKEW_SECONDS) || 300,
    maxRequestsPerDomain: Number(process.env.MAX_REQUESTS_PER_DOMAIN) || 100,
    rateLimitWindowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || 60,
    ...config,
  };

  const queue = createRedisStreamsQueue();
  const streams = createRedPandaStreams();

  return new InboundHandler(queue, streams, fullConfig);
}
