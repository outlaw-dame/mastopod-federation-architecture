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
import { metrics } from "../metrics/index.js";
import { logger } from "../utils/logger.js";
import { CapabilityGateResult } from "../capabilities/gates.js";
import type { SigningClient } from "../signing/signing-client.js";
import type { FollowersSyncService } from "../federation/fep8fcf/FollowersSyncService.js";
import { COLLECTION_SYNC_HEADER } from "../federation/fep8fcf/CollectionSyncHeader.js";

// ============================================================================
// Types
// ============================================================================

export interface InboundWorkerConfig {
  concurrency: number;
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs: number;
  userAgent: string;
  /** TTL for remote actor document cache entries in Redis. Defaults to 3600000 (1h). */
  actorCacheTtlMs?: number;
  capabilityGate?: (capabilityId: string) => CapabilityGateResult;
  fedifyRuntimeIntegrationEnabled: boolean;
  /** Injected adapter — defaults to NoopFederationRuntimeAdapter when flag is off. */
  adapter?: FederationRuntimeAdapter;
  /**
   * Set of inbox path prefixes (e.g. "/users/relay") that correspond to
   * sidecar-managed service actors.  Inbound activities targeting these paths
   * are acknowledged and published to Stream2 without being forwarded to
   * ActivityPods (which has no record of these actors).
   */
  sidecarActorPaths?: Set<string>;
  /**
   * FEP-8fcf followers sync service.  When present, inbound activities with a
   * Collection-Synchronization header will trigger async digest comparison and
   * reconciliation.  Failures are swallowed — sync is optional per spec.
   */
  followersSyncService?: FollowersSyncService;
  /**
   * Signing client needed to sign the authenticated GET to the remote partial
   * followers collection URL when a digest mismatch is detected.
   */
  followersSyncSigningClient?: SigningClient;
  /**
   * Public hostname of this sidecar (e.g. "social.example.com").
   * Used to construct canonical local actor URIs for FEP-8fcf request signing.
   * Also used to detect locally-authored activities (actor domain matches) and
   * route them to Stream1 instead of Stream2.
   */
  domain?: string;
  /**
   * Optional injectable bridge for forwarding inbound activities to ActivityPods.
   * When provided, replaces the default HTTP-based forwardToActivityPods path.
   * Primarily used for in-process testing.
   */
  activityPodsBridge?: {
    forwardInboundActivity(
      envelope: { path: string; headers: Record<string, string> },
      activity: unknown,
      actorUri: string,
    ): Promise<{ status: number }>;
  };
  /**
   * Optional injectable AT projection service.
   * When provided, called (fault-isolated) after successful ActivityPods forwarding
   * for public activities to project AP events into the AT protocol space.
   */
  atProjection?: {
    projectToCanonical(activity: unknown, actorUri: string): Promise<unknown>;
  };
  /**
   * Optional injectable canonical event publisher.
   * When provided, called (fault-isolated) after AT projection attempt.
   */
  canonicalPublisher?: {
    publish(event: unknown): Promise<void>;
  };
  /**
   * Optional set for in-process idempotency tracking (primarily for tests).
   * When provided, activity IDs are checked/recorded here to gate duplicate
   * stream writes and bridge forwarding.
   */
  seenActivityIds?: Set<string>;
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

/** Extract hostname from a URI, or null if unparseable. */
function extractDomain(uri: string): string | null {
  try {
    return new URL(uri).hostname || null;
  } catch {
    return null;
  }
}

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

  /** Call atProjection.projectToCanonical fault-isolated. */
  private async invokeAtProjection(
    activity: unknown,
    actorUri: string,
    envelopeId: string,
  ): Promise<void> {
    if (!this.config.atProjection) return;
    try {
      await this.config.atProjection.projectToCanonical(activity, actorUri);
    } catch (err: any) {
      logger.warn("AT projection failed (swallowed)", {
        envelopeId,
        error: err.message,
      });
    }
  }

  /** Call canonicalPublisher.publish fault-isolated. */
  private async invokeCanonicalPublisher(
    event: unknown,
    envelopeId: string,
  ): Promise<void> {
    if (!this.config.canonicalPublisher) return;
    try {
      await this.config.canonicalPublisher.publish(event);
    } catch (err: any) {
      logger.warn("Canonical publisher failed (swallowed)", {
        envelopeId,
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

  getConcurrency(): number {
    return this.config.concurrency;
  }

  setConcurrency(nextConcurrency: number): void {
    const normalized = Math.max(1, Math.floor(nextConcurrency));
    if (normalized === this.config.concurrency) return;

    const previous = this.config.concurrency;
    this.config.concurrency = normalized;
    logger.info("Inbound worker concurrency updated", {
      previous,
      next: normalized,
    });
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

      // Capability gate check (defense-in-depth: HTTP route also checks, but worker
      // runs independently and capability state may change after enqueue time)
      if (this.config.capabilityGate) {
        const gate = this.config.capabilityGate("ap.federation.ingress");
        if (!gate.allowed) {
          await this.queue.ack("inbound", messageId);
          await this.queue.moveToDlq("inbound", envelope, gate.message || `Capability denied: ${gate.reasonCode || "feature_disabled"}`);
          logger.warn("Inbound processing skipped by capability gate", {
            envelopeId: envelope.envelopeId,
            capabilityId: "ap.federation.ingress",
            reasonCode: gate.reasonCode,
          });
          return;
        }
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
      const activityType = this.normalizeActivityType(activity?.type);
      metrics.inboundActivityPubActivities.inc({ stage: "received", activity_type: activityType });

      if (!activity.type || !activity.actor) {
        metrics.inboundActivityPubActivities.inc({ stage: "rejected", activity_type: activityType });
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

      // Step 3.5: FEP-8fcf — process Collection-Synchronization header if present.
      // Fire-and-forget: errors are swallowed so they never block activity processing.
      const collectionSyncHeader = envelope.headers[COLLECTION_SYNC_HEADER];
      if (
        collectionSyncHeader &&
        this.config.followersSyncService &&
        this.config.followersSyncSigningClient
      ) {
        const syncService = this.config.followersSyncService;
        const syncSigningClient = this.config.followersSyncSigningClient;
        // Derive the local actor URI from the inbox path so we can sign the
        // authenticated GET to the remote partial collection URL.
        const localActorUri = this.deriveLocalActorUriFromInboxPath(envelope.path);
        if (localActorUri) {
          // Fetch the sender's actor document to get their followers collection URI.
          // We already have it in cache from signature verification above.
          this.fetchActorDocument(verifiedActorUri).then((actorDoc) => {
            if (!actorDoc || typeof actorDoc !== "object") return;
            return syncService.processInboundSyncHeader(
              collectionSyncHeader,
              verifiedActorUri,
              actorDoc as Record<string, unknown>,
              syncSigningClient,
              localActorUri,
            );
          }).catch((err: Error) => {
            logger.warn("[fep8fcf] inbound sync header processing failed (swallowed)", {
              envelopeId: envelope.envelopeId,
              error: err.message,
            });
          });
        }
      }

      // Step 3.5b: Domain block check — reject activities from blocked domains.
      {
        const actorDomain = extractDomain(verifiedActorUri);
        if (actorDomain) {
          const blocked = await this.queue.isDomainBlocked(actorDomain);
          if (blocked) {
            metrics.inboundActivityPubActivities.inc({ stage: "domain_blocked", activity_type: activityType });
            await this.queue.ack("inbound", messageId);
            logger.info("Activity from blocked domain discarded", {
              envelopeId: envelope.envelopeId,
              actorDomain,
            });
            return;
          }
        }
      }

      // Step 3.75: In-process idempotency gate (primarily for testing; production
      // idempotency is handled at the Redis queue level).
      if (this.config.seenActivityIds && activity.id) {
        const activityId = String(activity.id);
        if (this.config.seenActivityIds.has(activityId)) {
          await this.queue.ack("inbound", messageId);
          logger.debug("Duplicate activity suppressed by in-process idempotency gate", {
            activityId,
          });
          return;
        }
        this.config.seenActivityIds.add(activityId);
      }

      // Step 4: Check if activity is public
      const isPublic = this.isPublicActivity(activity);

      // Step 4.1: Detect sidecar-managed actors by actor URI path.
      // Sidecar actors (e.g. /users/relay) take the Stream2 fast-path regardless
      // of whether they are on the local domain; ActivityPods never manages them.
      const isSidecarActor = (() => {
        if (!this.config.sidecarActorPaths) return false;
        try {
          const actorPath = new URL(verifiedActorUri).pathname;
          return this.config.sidecarActorPaths.has(actorPath);
        } catch {
          return false;
        }
      })();

      if (isSidecarActor) {
        metrics.inboundActivityPubActivities.inc({ stage: "sidecar_actor_uri", activity_type: activityType });
        await this.queue.ack("inbound", messageId);
        if (isPublic) {
          try {
            await this.redpanda.publishToStream2({
              activity,
              actorUri: verifiedActorUri,
              receivedAt: envelope.receivedAt,
              path: envelope.path,
            });
          } catch (err: any) {
            logger.error("Failed to publish sidecar-actor activity to Stream2", {
              envelopeId: envelope.envelopeId,
              error: err.message,
            });
          }
        }
        // Canonical publisher (fault-isolated) for sidecar actor activities
        await this.invokeCanonicalPublisher(
          { activity, actorUri: verifiedActorUri, isPublic, isPrivate: !isPublic, isLocal: false },
          envelope.envelopeId,
        );
        logger.info("Inbound activity handled for sidecar actor (actor URI path)", {
          envelopeId: envelope.envelopeId,
          actorUri: verifiedActorUri,
          activityType,
        });
        return;
      }

      // Step 4.25: Detect locally-authored activities.
      // When a local actor (domain matches config.domain) appears on the inbound
      // path, route to Stream1 (not Stream2) and skip ActivityPods forwarding.
      const isLocalActor =
        typeof this.config.domain === "string" &&
        this.config.domain.length > 0 &&
        typeof verifiedActorUri === "string" &&
        verifiedActorUri.includes(`://${this.config.domain}/`);

      if (isLocalActor) {
        metrics.inboundActivityPubActivities.inc({ stage: "local_actor", activity_type: activityType });
        await this.queue.ack("inbound", messageId);
        if (isPublic) {
          try {
            await this.redpanda.publishToStream1({
              activity,
              actorUri: verifiedActorUri,
              receivedAt: envelope.receivedAt,
              path: envelope.path,
            });
          } catch (err: any) {
            logger.error("Failed to publish local-actor activity to Stream1", {
              envelopeId: envelope.envelopeId,
              error: err.message,
            });
          }
        }
        // AT projection + canonical (fault-isolated) for local activities
        await this.invokeAtProjection(activity, verifiedActorUri, envelope.envelopeId);
        {
          const kind =
            activityType === "Update"
              ? "PostEdit"
              : activityType === "Delete" || activityType === "Undo"
                ? "PostDelete"
                : undefined;
          await this.invokeCanonicalPublisher(
            { activity, actorUri: verifiedActorUri, isPublic, isPrivate: !isPublic, isLocal: true, ...(kind ? { kind } : {}) },
            envelope.envelopeId,
          );
        }
        logger.info("Inbound activity handled for local actor (Stream1 path)", {
          envelopeId: envelope.envelopeId,
          path: envelope.path,
          activityType,
        });
        return;
      }

      // Step 4.5: Short-circuit for sidecar-owned actor inboxes.
      // These actors (e.g. /users/relay) are managed by the sidecar, not by
      // ActivityPods, so forwarding would always 404.  Ack immediately and
      // fall through to Stream2 publication below.
      if (this.config.sidecarActorPaths) {
        const pathWithoutInbox = envelope.path.replace(/\/inbox$/, "");
        if (this.config.sidecarActorPaths.has(pathWithoutInbox)) {
          metrics.inboundActivityPubActivities.inc({ stage: "sidecar_actor", activity_type: activityType });
          await this.queue.ack("inbound", messageId);
          if (isPublic) {
            try {
              await this.redpanda.publishToStream2({
                activity,
                actorUri: verifiedActorUri,
                receivedAt: envelope.receivedAt,
                path: envelope.path,
              });
            } catch (err: any) {
              logger.error("Failed to publish sidecar-actor activity to Stream2", {
                envelopeId: envelope.envelopeId,
                error: err.message,
              });
            }
          }
          logger.info("Inbound activity handled for sidecar actor", {
            envelopeId: envelope.envelopeId,
            path: envelope.path,
            activityType,
          });
          return;
        }
      }

      // Step 5: Forward to ActivityPods (via injectable bridge or HTTP).
      let forwardedSuccessfully = false;
      if (this.config.activityPodsBridge) {
        try {
          await this.config.activityPodsBridge.forwardInboundActivity(
            { path: envelope.path, headers: envelope.headers },
            activity,
            verifiedActorUri,
          );
          forwardedSuccessfully = true;
        } catch (err: any) {
          metrics.inboundActivityPubActivities.inc({ stage: "failed_forward", activity_type: activityType });
          await this.queue.ack("inbound", messageId);
          await this.queue.moveToDlq("inbound", envelope, `Bridge forward failed: ${err.message}`);
          logger.warn("Injectable bridge forward failed", {
            envelopeId: envelope.envelopeId,
            error: err.message,
          });
          return;
        }
      } else {
        const forwardResult = await this.forwardToActivityPods(envelope, activity, verifiedActorUri);

        if (!forwardResult.success) {
          metrics.inboundActivityPubActivities.inc({ stage: "failed_forward", activity_type: activityType });
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
        forwardedSuccessfully = true;
      }

      // Step 6: Publish public activities to Stream2 (remote actors only).
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
            type: activity.type,
          });
        } catch (err: any) {
          // Log but don't fail — Stream2 is best-effort
          logger.error("Failed to publish to Stream2", {
            envelopeId: envelope.envelopeId,
            error: err.message,
          });
        }

        // Step 6.1: Tombstone lifecycle activities that remove content.
        const tombstoneTypes = new Set(["Delete", "Undo"]);
        if (tombstoneTypes.has(String(activity.type))) {
          try {
            const objectId =
              typeof activity.object === "string"
                ? activity.object
                : typeof activity.object?.id === "string"
                  ? activity.object.id
                  : undefined;
            await this.redpanda.publishTombstone({
              activityId: String(activity.id ?? ""),
              objectId,
              actorUri: verifiedActorUri,
              deletedAt: Date.now(),
            });
          } catch (err: any) {
            logger.error("Failed to publish tombstone", {
              envelopeId: envelope.envelopeId,
              error: err.message,
            });
          }
        }
      }

      // Step 6.5: AT projection (fault-isolated — never affects AP routing).
      await this.invokeAtProjection(activity, verifiedActorUri, envelope.envelopeId);

      // Step 6.7: Canonical event publisher (fault-isolated).
      {
        const kind =
          activityType === "Update"
            ? "PostEdit"
            : activityType === "Delete" || activityType === "Undo"
              ? "PostDelete"
              : undefined;
        await this.invokeCanonicalPublisher(
          { activity, actorUri: verifiedActorUri, isPublic, isPrivate: !isPublic, isLocal: false, ...(kind ? { kind } : {}) },
          envelope.envelopeId,
        );
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

      void forwardedSuccessfully; // used above, silence lint

      metrics.inboundActivityPubActivities.inc({ stage: "processed", activity_type: activityType });

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
      const activityType = this.normalizeActivityType(activity?.type);
      metrics.inboundActivityPubActivities.inc({ stage: "rejected", activity_type: activityType });
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
    if (envelope.verification?.source !== "fedify-v2") {
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
    const activityType = this.normalizeActivityType(activity?.type);

    if (!activityActorUri) {
      metrics.inboundActivityPubActivities.inc({ stage: "rejected", activity_type: activityType });
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
      metrics.inboundActivityPubActivities.inc({ stage: "rejected", activity_type: activityType });
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

  private normalizeActivityType(type: unknown): string {
    if (typeof type === "string" && type.trim().length > 0) {
      return type.trim().slice(0, 64);
    }
    return "unknown";
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
      await this.queue.cacheActorDoc(fetchUrl, doc, Math.ceil((this.config.actorCacheTtlMs ?? 3_600_000) / 1000));

      return doc;

    } catch (err: any) {
      logger.error("Error fetching verification document", { fetchUrl, error: err.message });
      return null;
    }
  }

  /**
   * Derive a local actor URI from an inbox path, e.g.:
   *   "/users/alice/inbox" → "https://example.com/users/alice"
   *   "/inbox"             → null (shared inbox — no single actor)
   *
   * Used to choose a signer for FEP-8fcf authenticated GETs.
   */
  private deriveLocalActorUriFromInboxPath(inboxPath: string): string | null {
    const m = inboxPath.match(/^\/users\/([^/?#]+)\/inbox$/);
    if (!m || !m[1]) return null;
    // Use the configured public domain when available; otherwise fall back to
    // the ActivityPods URL origin (useful in local dev / tests).
    const origin = this.config.domain
      ? `https://${this.config.domain}`
      : (() => {
          try { return new URL(this.config.activityPodsUrl).origin; } catch { return null; }
        })();
    if (!origin) return null;
    return `${origin}/users/${m[1]}`;
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
      const isBenchmark = envelope.headers?.["x-sidecar-benchmark"] === "1";

      const response = await request(
        `${this.config.activityPodsUrl}/api/internal/activitypub-bridge/inbox/receive`,
        {
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
          benchmark: isBenchmark,
        }),
        bodyTimeout: this.config.requestTimeoutMs,
        headersTimeout: this.config.requestTimeoutMs,
        }
      );

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
    actorCacheTtlMs: parseInt(process.env["ACTOR_CACHE_TTL_MS"] || "3600000", 10),
    fedifyRuntimeIntegrationEnabled:
      process.env["ENABLE_FEDIFY_RUNTIME_INTEGRATION"] === "true",
    domain: process.env["DOMAIN"],
    ...overrides,
  };

  // Safety invariant: claim idle timeout must exceed the per-request timeout.
  // If claimIdleTimeMs ≤ requestTimeoutMs, xAutoClaim can reclaim a message
  // while the original worker is still awaiting the HTTP response, causing
  // duplicate delivery to ActivityPods.
  const claimIdleMs = queue.getClaimIdleTimeMs();
  if (claimIdleMs <= config.requestTimeoutMs) {
    throw new Error(
      `Configuration error: CLAIM_IDLE_TIME_MS (${claimIdleMs}ms) must be ` +
      `greater than REQUEST_TIMEOUT_MS (${config.requestTimeoutMs}ms). ` +
      `Risk of double-delivery via xAutoClaim.`
    );
  }

  return new InboundWorker(queue, redpanda, config);
}
