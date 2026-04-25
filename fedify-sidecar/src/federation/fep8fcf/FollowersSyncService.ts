/**
 * FEP-8fcf Followers Collection Synchronization Service.
 *
 * Implements both sides of the protocol:
 *
 * SENDER SIDE
 *   `buildSenderHeader()` — given an outbound delivery job, computes the
 *   partial followers digest for the target domain and returns the fully
 *   formatted Collection-Synchronization header value.  Digests are cached
 *   in Redis (5 min TTL) to avoid an ActivityPods round-trip on every
 *   follower-addressed activity delivery.
 *
 * RECEIVER SIDE
 *   `processInboundSyncHeader()` — validates the inbound header, computes the
 *   local partial digest, and triggers reconciliation when the digests differ.
 *   This is intentionally fire-and-forget: failures are logged and swallowed so
 *   they never block normal inbound activity processing.
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/8fcf/fep-8fcf.md
 */

import { request } from "undici";
import type { SigningClient } from "../../signing/signing-client.js";
import { logger } from "../../utils/logger.js";
import {
  parseCollectionSyncHeader,
  serializeCollectionSyncHeader,
  validateCollectionSyncHeader,
  extractFollowersUri,
  type CollectionSyncParams,
} from "./CollectionSyncHeader.js";
import {
  computePartialFollowersDigest,
  extractOrigin,
} from "./PartialFollowersDigest.js";
import {
  FollowersSyncActivityPodsClient,
  type LocalActorFollowerRecord,
} from "./FollowersSyncActivityPodsClient.js";

// ============================================================================
// Configuration
// ============================================================================

/** Duck-typed Redis interface; compatible with both ioredis and node-redis. */
export interface FollowersSyncRedisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exFlag: "EX", ttlSeconds: number): Promise<unknown>;
}

export interface FollowersSyncServiceConfig {
  /** Public hostname of this sidecar, e.g. "social.example.com". */
  domain: string;
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs?: number;
  userAgent?: string;
  /** Optional Redis client for caching partial digests. */
  redisCache?: FollowersSyncRedisCache;
  /**
   * TTL (seconds) for cached per-domain partial digests.
   * Default: 300 (5 min). After this period the digest is recomputed from
   * ActivityPods to pick up new followers/unfollows.
   */
  digestCacheTtlSeconds?: number;
}

// ============================================================================
// Internal types
// ============================================================================

interface CachedDigest {
  digest: string;
  computedAt: number;
}

// ============================================================================
// Service
// ============================================================================

export class FollowersSyncService {
  private readonly domain: string;
  private readonly apClient: FollowersSyncActivityPodsClient;
  private readonly redis: FollowersSyncRedisCache | null;
  private readonly digestCacheTtlSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly userAgent: string;

  constructor(config: FollowersSyncServiceConfig) {
    this.domain = config.domain;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.userAgent = config.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)";
    this.redis = config.redisCache ?? null;
    this.digestCacheTtlSeconds = config.digestCacheTtlSeconds ?? 300;
    this.apClient = new FollowersSyncActivityPodsClient({
      activityPodsUrl: config.activityPodsUrl,
      activityPodsToken: config.activityPodsToken,
      requestTimeoutMs: this.requestTimeoutMs,
    });
  }

  // ==========================================================================
  // SENDER SIDE
  // ==========================================================================

  /**
   * Build the `Collection-Synchronization` header value for an outbound
   * delivery.
   *
   * Returns `null` when the feature should be skipped (e.g. ActivityPods
   * endpoints not yet implemented, zero followers from that domain, or any
   * internal error — sync is optional, never blocking).
   *
   * @param actorIdentifier  Local identifier, e.g. "alice".
   * @param followersUri     Sender's followers collection URI from their actor doc.
   * @param targetInboxUrl   Full inbox URL of the delivery target — used to
   *                         derive the target instance origin.
   */
  async buildSenderHeader(
    actorIdentifier: string,
    followersUri: string,
    targetInboxUrl: string,
  ): Promise<string | null> {
    try {
      const targetOrigin = extractOrigin(targetInboxUrl);
      if (!targetOrigin) return null;

      const digest = await this.getOrComputeDigest(actorIdentifier, targetOrigin);
      if (digest === null) return null;

      // Partial followers synchronization URL for the receiving instance.
      const syncUrl = `https://${this.domain}/users/${encodeURIComponent(actorIdentifier)}/followers_synchronization`;

      const params: CollectionSyncParams = {
        collectionId: followersUri,
        url: syncUrl,
        digest,
      };

      return serializeCollectionSyncHeader(params);
    } catch (err: any) {
      logger.warn("[fep8fcf] buildSenderHeader error (non-fatal)", {
        actorIdentifier,
        targetInboxUrl,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Return the partial followers list for `actorIdentifier` scoped to
   * `requestingDomain`.  Used by the /followers_synchronization HTTP endpoint.
   */
  async getPartialFollowersCollection(
    actorIdentifier: string,
    requestingDomain: string,
  ): Promise<string[]> {
    return this.apClient.getPartialFollowers(actorIdentifier, requestingDomain);
  }

  // ==========================================================================
  // RECEIVER SIDE
  // ==========================================================================

  /**
   * Process an inbound `Collection-Synchronization` header.
   *
   * Validates the header, computes the local partial digest, and triggers
   * reconciliation asynchronously if the digests differ.
   *
   * Always returns without throwing.  All errors are logged and swallowed.
   *
   * @param headerValue       Raw value of the Collection-Synchronization header.
   * @param senderActorUri    Verified sender actor URI.
   * @param senderActorDoc    Raw sender actor document (used to extract
   *                          the authoritative followers collection URI).
   * @param signingClient     Used to sign the authenticated GET to the remote
   *                          partial collection URL when digests differ.
   * @param localActorUri     A local actor URI to sign the fetch request as.
   *                          Typically the actor whose inbox received the activity.
   */
  async processInboundSyncHeader(
    headerValue: string,
    senderActorUri: string,
    senderActorDoc: Record<string, unknown>,
    signingClient: SigningClient,
    localActorUri: string,
  ): Promise<void> {
    try {
      // --- Parse ---
      const params = parseCollectionSyncHeader(headerValue);
      if (!params) {
        logger.debug("[fep8fcf] inbound: unparseable Collection-Synchronization header", {
          senderActorUri,
        });
        return;
      }

      // --- Validate ---
      const senderFollowersUri = extractFollowersUri(senderActorDoc, senderActorUri);
      const validation = validateCollectionSyncHeader(params, senderFollowersUri);
      if (!validation.valid) {
        logger.debug("[fep8fcf] inbound: header validation failed", {
          senderActorUri,
          reason: (validation as { valid: false; reason: string }).reason,
        });
        return;
      }

      // --- Compute local partial digest ---
      const localFollowers = await this.apClient.getLocalFollowersOfRemote(senderActorUri);
      const localFollowerUris = localFollowers.map((f) => f.actorUri);
      const localDigest = computePartialFollowersDigest(localFollowerUris);

      if (localDigest === params.digest) {
        logger.debug("[fep8fcf] inbound: digest match — no reconciliation needed", {
          senderActorUri,
          digest: localDigest,
        });
        return;
      }

      logger.info("[fep8fcf] inbound: digest mismatch — fetching remote partial collection", {
        senderActorUri,
        localDigest,
        remoteDigest: params.digest,
        localFollowerCount: localFollowerUris.length,
      });

      // --- Fetch authoritative partial collection from remote ---
      const remoteFollowers = await this.fetchRemotePartialCollection(
        params.url,
        localActorUri,
        signingClient,
      );

      if (remoteFollowers === null) {
        logger.warn("[fep8fcf] inbound: could not fetch remote partial collection", {
          senderActorUri,
          url: params.url,
        });
        return;
      }

      // --- Reconcile ---
      await this.reconcile(senderActorUri, localFollowers, remoteFollowers);
    } catch (err: any) {
      logger.warn("[fep8fcf] processInboundSyncHeader error (non-fatal)", {
        senderActorUri,
        error: err.message,
      });
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /** Return a cached digest or compute a fresh one via ActivityPods. */
  private async getOrComputeDigest(
    actorIdentifier: string,
    targetOrigin: string,
  ): Promise<string | null> {
    const cacheKey = `fep8fcf:digest:${actorIdentifier}:${encodeURIComponent(targetOrigin)}`;

    if (this.redis) {
      try {
        const raw = await this.redis.get(cacheKey);
        if (raw) {
          const entry = JSON.parse(raw) as CachedDigest;
          return entry.digest;
        }
      } catch {
        // Redis unavailable — fall through to fresh computation
      }
    }

    const followers = await this.apClient.getPartialFollowers(actorIdentifier, targetOrigin);
    const digest = computePartialFollowersDigest(followers);

    if (this.redis) {
      try {
        const entry: CachedDigest = { digest, computedAt: Date.now() };
        await this.redis.set(
          cacheKey,
          JSON.stringify(entry),
          "EX",
          this.digestCacheTtlSeconds,
        );
      } catch {
        // Redis write failure is non-fatal
      }
    }

    return digest;
  }

  /**
   * Perform an authenticated GET to `url` and parse the result as an
   * ActivityStreams (Ordered)Collection of follower URIs.
   *
   * Returns `null` on any fetch or parse error.
   */
  private async fetchRemotePartialCollection(
    url: string,
    signerActorUri: string,
    signingClient: SigningClient,
  ): Promise<string[] | null> {
    try {
      const signResult = await signingClient.signOne({
        actorUri: signerActorUri,
        method: "GET",
        targetUrl: url,
      });

      if (!signResult.ok) {
        logger.warn("[fep8fcf] fetchRemotePartialCollection: signing failed", {
          url,
          error: (signResult as { ok: false; error: { message: string } }).error.message,
        });
        return null;
      }

      const { date, signature } = signResult.signedHeaders;
      const parsedUrl = new URL(url);

      const resp = await request(url, {
        method: "GET",
        headers: {
          accept: "application/activity+json, application/ld+json",
          date,
          signature,
          host: parsedUrl.host,
          "user-agent": this.userAgent,
        },
        bodyTimeout: this.requestTimeoutMs,
        headersTimeout: this.requestTimeoutMs,
        maxRedirections: 0,
      });

      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        await resp.body.text();
        logger.warn("[fep8fcf] fetchRemotePartialCollection: non-OK response", {
          url,
          status: resp.statusCode,
        });
        return null;
      }

      const body = await resp.body.json() as Record<string, unknown>;
      const items = (body["orderedItems"] ?? body["items"]);
      if (!Array.isArray(items)) return null;

      return items.reduce<string[]>((acc, item) => {
        if (typeof item === "string") {
          acc.push(item);
        } else if (
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>)["id"] === "string"
        ) {
          acc.push((item as Record<string, unknown>)["id"] as string);
        }
        return acc;
      }, []);
    } catch (err: any) {
      logger.warn("[fep8fcf] fetchRemotePartialCollection: request error", {
        url,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Reconcile local follow state against the remote's authoritative partial
   * collection.
   *
   * Per FEP-8fcf §3.3:
   *  1. SHOULD remove any local follower not listed in the remote collection.
   *  2. SHOULD log (and optionally emit an Undo Follow for) any remote entry
   *     that is not known locally.
   *
   * Note: "Remove" here means updating ActivityPods' local follow graph via
   * the removeLocalFollow API.  Sending an Undo Follow activity to the remote
   * for #1 is NOT done here — the remote already excluded them from its list,
   * so they're no longer a follower on the remote side.
   *
   * For #2 (remote claims a local actor follows, but we have no record), we
   * log the discrepancy.  A future enhancement can enqueue an Undo Follow
   * outbound activity to clean up the remote's state.
   */
  private async reconcile(
    senderActorUri: string,
    localFollowers: LocalActorFollowerRecord[],
    remotePartialFollowers: string[],
  ): Promise<void> {
    const localOrigin = `https://${this.domain}`;

    // Filter the remote list to only entries that claim to be from our domain.
    const remoteLocalUris = remotePartialFollowers.filter((uri) => {
      try { return new URL(uri).origin === localOrigin; } catch { return false; }
    });
    const remoteSet = new Set(remoteLocalUris);
    const localMap = new Map(localFollowers.map((f) => [f.actorUri, f]));

    let removedCount = 0;
    let staleCount = 0;

    // 1. Local actors not listed in remote → remove from local follow graph.
    for (const [actorUri, record] of localMap) {
      if (!remoteSet.has(actorUri)) {
        const ok = await this.apClient.removeLocalFollow(record.identifier, senderActorUri);
        if (ok) {
          removedCount++;
          logger.info("[fep8fcf] reconcile: removed stale local follow", {
            localActorUri: actorUri,
            senderActorUri,
          });
        }
      }
    }

    // 2. Remote entries not known locally → log discrepancy.
    for (const uri of remoteLocalUris) {
      if (!localMap.has(uri)) {
        staleCount++;
        logger.info("[fep8fcf] reconcile: remote has unknown local follower (stale remote entry)", {
          senderActorUri,
          unknownLocalFollower: uri,
        });
        // TODO: enqueue an outbound Undo Follow activity for `uri` acting as
        // the local actor so the remote cleans its followers list.
      }
    }

    logger.info("[fep8fcf] reconcile: done", {
      senderActorUri,
      localCount: localFollowers.length,
      remoteLocalCount: remoteLocalUris.length,
      removedCount,
      staleRemoteCount: staleCount,
    });
  }
}
