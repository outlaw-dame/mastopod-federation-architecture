/**
 * Inbound Worker
 * 
 * Processes inbound envelopes from the Redis Streams queue.
 * Verifies inbound deliveries when needed, validates activities, and forwards
 * them to ActivityPods.
 * Also publishes public activities to Stream2 (RedPanda).
 * 
 * Key principles:
 * - Trust only explicitly marked, runtime-verified envelopes
 * - HTTP signature verification before processing for raw fallback ingress
 * - Actor document fetching with caching
 * - Forward verified activities to ActivityPods
 * - Publish public activities to Stream2
 */

import { request } from "undici";
import { createVerify, createHash } from "node:crypto";
import {
  RedisStreamsQueue,
  InboundEnvelope,
  InboundEnvelopeVerification,
  backoffMs,
} from "../queue/sidecar-redis-queue.js";
import { RedPandaProducer } from "../streams/redpanda-producer.js";
import {
  FederationRuntimeAdapter,
  NoopFederationRuntimeAdapter,
} from "../core-domain/contracts/SigningContracts.js";
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
  fedifyRuntimeIntegrationEnabled: boolean;
  /** Injected adapter — defaults to NoopFederationRuntimeAdapter when flag is off. */
  adapter?: FederationRuntimeAdapter;
}

export interface VerificationResult {
  valid: boolean;
  actorUri?: string;
  error?: string;
}

const MAX_INBOUND_ATTEMPTS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function looksLikeActorType(value: unknown): boolean {
  const actorTypes = new Set([
    "Application",
    "Group",
    "Organization",
    "Person",
    "Service",
  ]);

  if (typeof value === "string") {
    return actorTypes.has(value);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === "string" && actorTypes.has(entry));
  }

  return false;
}

function looksLikeActorDocument(document: Record<string, unknown>): boolean {
  return (
    looksLikeActorType(document["type"]) ||
    isNonEmptyString(document["inbox"]) ||
    isNonEmptyString(document["preferredUsername"]) ||
    isNonEmptyString(document["followers"]) ||
    isNonEmptyString(document["following"])
  );
}

export function extractPublicKeyPemFromVerificationDocument(document: unknown): string | null {
  if (!isRecord(document)) {
    return null;
  }

  if (isNonEmptyString(document["publicKeyPem"])) {
    return document["publicKeyPem"];
  }

  const publicKey = document["publicKey"];
  if (isRecord(publicKey) && isNonEmptyString(publicKey["publicKeyPem"])) {
    return publicKey["publicKeyPem"];
  }

  return null;
}

export function resolveActorUriFromVerificationDocument(
  keyId: string,
  document: unknown,
): string | null {
  if (isRecord(document)) {
    const publicKey = isRecord(document["publicKey"]) ? document["publicKey"] : null;
    const ownerCandidate =
      document["owner"] ??
      document["controller"] ??
      publicKey?.["owner"] ??
      publicKey?.["controller"];

    if (isNonEmptyString(ownerCandidate)) {
      return ownerCandidate;
    }

    if (isNonEmptyString(document["id"]) && looksLikeActorDocument(document)) {
      return document["id"];
    }
  }

  return keyId.includes("#") ? (keyId.split("#")[0] ?? null) : null;
}

// ============================================================================
// Inbound Worker
// ============================================================================

export class InboundWorker {
  private queue: RedisStreamsQueue;
  private redpanda: RedPandaProducer;
  private config: InboundWorkerConfig;
  private adapter: FederationRuntimeAdapter;
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
    this.adapter = config.fedifyRuntimeIntegrationEnabled
      ? (config.adapter ?? NoopFederationRuntimeAdapter)
      : NoopFederationRuntimeAdapter;
  }

  /**
   * Invoke a FederationRuntimeAdapter hook inside a noop-safe circuit-breaker.
   * Errors thrown by the adapter are logged and swallowed — they must never
   * affect the calling business-logic path.
   */
  private async callAdapter(
    hook: "onInboundVerified",
    input: NonNullable<Parameters<NonNullable<FederationRuntimeAdapter["onInboundVerified"]>>[0]>
  ): Promise<void> {
    if (!this.adapter.enabled) return;
    const fn = this.adapter[hook];
    if (!fn) return;
    try {
      await fn.call(this.adapter, input);
    } catch (err: any) {
      logger.warn("FederationRuntimeAdapter hook threw (swallowed)", {
        hook,
        error: err.message,
      });
    }
  }

  /**
   * Start the worker loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Inbound worker started", {
      concurrency: this.config.concurrency,
      fedifyRuntimeIntegrationEnabled: this.config.fedifyRuntimeIntegrationEnabled,
    });

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
  protected async processEnvelope(messageId: string, envelope: InboundEnvelope): Promise<void> {
    this.activeJobs++;

    try {
      // Step 0: Honour delayed retry — re-enqueue and ack if not yet due.
      if (envelope.notBeforeMs > 0 && Date.now() < envelope.notBeforeMs) {
        await this.queue.enqueueInbound(envelope);
        await this.queue.ack("inbound", messageId);
        return;
      }

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

      // Step 2: Basic activity validation
      if (!activity.type || !activity.actor) {
        await this.queue.ack("inbound", messageId);
        await this.queue.moveToDlq("inbound", envelope, "Missing required activity fields");
        logger.warn("Invalid activity structure", { envelopeId: envelope.envelopeId });
        return;
      }

      // Step 3: Resolve the verified actor, trusting only envelopes that were
      // verified by the enabled Fedify ingress path before they entered Redis.
      const verifiedActorUri = await this.resolveVerifiedActorUri(messageId, envelope, activity);
      if (!verifiedActorUri) {
        return;
      }

      // Step 4: Check if activity is public
      const isPublic = this.isPublicActivity(activity);

      // Step 5: Forward to ActivityPods
      const forwardResult = await this.forwardToActivityPods(envelope, activity, verifiedActorUri);
      
      if (!forwardResult.success) {
        await this.queue.ack("inbound", messageId);

        if (forwardResult.permanent || envelope.attempt >= MAX_INBOUND_ATTEMPTS) {
          await this.queue.moveToDlq(
            "inbound",
            envelope,
            forwardResult.permanent
              ? (forwardResult.error || "Forward failed (permanent)")
              : `Exhausted ${MAX_INBOUND_ATTEMPTS} attempts: ${forwardResult.error}`,
          );
          logger.warn("Inbound envelope moved to DLQ", {
            envelopeId: envelope.envelopeId,
            attempt: envelope.attempt,
            permanent: forwardResult.permanent,
            error: forwardResult.error,
          });
        } else {
          const nextAttempt = envelope.attempt + 1;
          const delay = backoffMs(nextAttempt);
          await this.queue.enqueueInbound({
            ...envelope,
            attempt: nextAttempt,
            notBeforeMs: Date.now() + delay,
          });
          logger.warn("Inbound envelope requeued with backoff", {
            envelopeId: envelope.envelopeId,
            attempt: nextAttempt,
            retryAt: new Date(Date.now() + delay).toISOString(),
            error: forwardResult.error,
          });
        }
        return;
      }

      // Step 6: Publish public activities to Stream2
      if (isPublic) {
        try {
          await this.redpanda.publishToStream2({
            activity,
            actorUri: verifiedActorUri,
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

      // Step 8: Notify integration adapter (fault-isolated — errors are swallowed)
      await this.callAdapter("onInboundVerified", {
        actorUri: verifiedActorUri,
        activityId: activity.id,
        activityType: activity.type,
        isPublic,
      });

      logger.info("Inbound activity processed", { 
        envelopeId: envelope.envelopeId,
        activityId: activity.id,
        type: activity.type,
        actor: verifiedActorUri,
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

  private async resolveVerifiedActorUri(
    messageId: string,
    envelope: InboundEnvelope,
    activity: any
  ): Promise<string | null> {
    const trustedVerification = this.getTrustedVerification(envelope);
    if (trustedVerification) {
      return this.validateVerifiedActorMatch(
        messageId,
        envelope,
        activity,
        trustedVerification.actorUri,
        trustedVerification.source,
      );
    }

    const verification = await this.verifySignature(envelope);

    if (!verification.valid || !verification.actorUri) {
      await this.queue.ack("inbound", messageId);
      await this.queue.moveToDlq(
        "inbound",
        envelope,
        `Signature verification failed: ${verification.error}`,
      );
      logger.warn("Signature verification failed", {
        envelopeId: envelope.envelopeId,
        error: verification.error,
      });
      return null;
    }

    return this.validateVerifiedActorMatch(
      messageId,
      envelope,
      activity,
      verification.actorUri,
      "http-signature",
    );
  }

  private getTrustedVerification(
    envelope: InboundEnvelope
  ): InboundEnvelopeVerification | null {
    if (
      !this.config.fedifyRuntimeIntegrationEnabled ||
      envelope.verification?.source !== "fedify-v2"
    ) {
      return null;
    }

    return envelope.verification;
  }

  private async validateVerifiedActorMatch(
    messageId: string,
    envelope: InboundEnvelope,
    activity: any,
    verifiedActorUri: string,
    verificationSource: string
  ): Promise<string | null> {
    const activityActorUri = this.extractActivityActorUri(activity);

    if (!activityActorUri) {
      await this.queue.ack("inbound", messageId);
      await this.queue.moveToDlq(
        "inbound",
        envelope,
        "Activity actor is missing a resolvable URI",
      );
      logger.warn("Inbound activity actor URI missing", {
        envelopeId: envelope.envelopeId,
        verificationSource,
      });
      return null;
    }

    if (activityActorUri !== verifiedActorUri) {
      await this.queue.ack("inbound", messageId);
      await this.queue.moveToDlq(
        "inbound",
        envelope,
        `Verified actor mismatch: envelope actor ${verifiedActorUri} != activity actor ${activityActorUri}`,
      );
      logger.warn("Inbound activity rejected due to actor mismatch", {
        envelopeId: envelope.envelopeId,
        verificationSource,
        verifiedActorUri,
        activityActorUri,
      });
      return null;
    }

    return verifiedActorUri;
  }

  private extractActivityActorUri(activity: any): string | null {
    if (typeof activity?.actor === "string" && activity.actor.length > 0) {
      return activity.actor;
    }

    if (
      activity?.actor &&
      typeof activity.actor === "object" &&
      typeof activity.actor.id === "string" &&
      activity.actor.id.length > 0
    ) {
      return activity.actor.id;
    }

    return null;
  }

  /**
   * Verify HTTP signature on an inbound envelope
   */
  protected async verifySignature(envelope: InboundEnvelope): Promise<VerificationResult> {
    try {
      const signatureHeader = envelope.headers["signature"];
      if (!signatureHeader) {
        return { valid: false, error: "Missing Signature header" };
      }

      // Parse signature header
      const sigParams = this.parseSignatureHeader(signatureHeader);
      const keyId = sigParams["keyId"];
      const signature = sigParams["signature"];
      const signedHeaders = sigParams["headers"];
      if (
        typeof keyId !== "string" ||
        typeof signature !== "string" ||
        typeof signedHeaders !== "string"
      ) {
        return { valid: false, error: "Invalid Signature header format" };
      }

      // Fetch an actor or key document to get the public key and actor owner.
      const verificationDocument = await this.fetchActorDocument(keyId);
      if (!verificationDocument) {
        return { valid: false, error: "Could not fetch actor or key document" };
      }

      const publicKeyPem = extractPublicKeyPemFromVerificationDocument(verificationDocument);
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
      const signingString = this.buildSigningString(envelope, signedHeaders.split(" "));

      // Verify signature
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signingString);
      const isValid = verifier.verify(publicKeyPem, signature, "base64");

      if (!isValid) {
        return { valid: false, error: "Signature verification failed" };
      }

      const actorUri = resolveActorUriFromVerificationDocument(keyId, verificationDocument);
      if (!actorUri) {
        return { valid: false, error: "Could not resolve actor owner for keyId" };
      }

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
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined) {
        params[key] = value;
      }
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
   * Fetch actor or key documents with caching.
   */
  private async fetchActorDocument(keyId: string): Promise<any | null> {
    const fetchUrl = keyId.includes("#") ? (keyId.split("#")[0] ?? null) : keyId;
    if (!fetchUrl) {
      return null;
    }

    // Check cache first
    const cached = await this.queue.getCachedActorDoc(fetchUrl);
    if (cached) {
      return cached;
    }

    try {
      const response = await request(fetchUrl, {
        method: "GET",
        headers: {
          "accept": "application/activity+json, application/ld+json",
          "user-agent": this.config.userAgent,
        },
        bodyTimeout: this.config.requestTimeoutMs,
        headersTimeout: this.config.requestTimeoutMs,
      });

      if (response.statusCode !== 200) {
        logger.warn("Failed to fetch verification document", { fetchUrl, statusCode: response.statusCode });
        return null;
      }

      const doc = await response.body.json() as any;

      // Cache the document
      await this.queue.cacheActorDoc(fetchUrl, doc);

      return doc;

    } catch (err: any) {
      logger.error("Error fetching verification document", { fetchUrl, error: err.message });
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
  /** Forward a verified activity to ActivityPods internal inbox receiver. */
  protected async forwardToActivityPods(
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
    concurrency: parseInt(process.env["INBOUND_CONCURRENCY"] || "32", 10),
    activityPodsUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
    activityPodsToken: process.env["ACTIVITYPODS_TOKEN"] || "",
    requestTimeoutMs: parseInt(process.env["REQUEST_TIMEOUT_MS"] || "30000", 10),
    userAgent: process.env["USER_AGENT"] || "Fedify-Sidecar/1.0 (ActivityPods)",
    fedifyRuntimeIntegrationEnabled:
      process.env["ENABLE_FEDIFY_RUNTIME_INTEGRATION"] === "true",
    ...overrides,
  };

  return new InboundWorker(queue, redpanda, config);
}
