import type { KvStore } from "@fedify/fedify";
import { logger } from "../../utils/logger.js";
import { extractActorIdentifier, extractOrigin } from "./PartialFollowersDigest.js";
import {
  FollowersSyncService,
  type FollowersSyncRedisCache,
} from "./FollowersSyncService.js";
import { isFollowersAddressedActivity } from "./FollowersSyncOutboundEligibility.js";

const CACHE_NAMESPACE = "fep8fcf-outbound-digest";

export interface FollowersSyncHeaderBuilder {
  buildHeader(input: {
    actorUri: string;
    activity: string;
    targetInbox: string;
  }): Promise<string | null>;
}

export interface FedifyFollowersSyncSenderConfig {
  domain: string;
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs?: number;
  userAgent?: string;
  enabled?: boolean;
}

function kvDigestCache(kv: KvStore): FollowersSyncRedisCache {
  return {
    async get(key: string): Promise<string | null> {
      const value = await kv.get<string>([CACHE_NAMESPACE, key]);
      return typeof value === "string" ? value : null;
    },
    async set(key: string, value: string, _exFlag: "EX", ttlSeconds: number): Promise<unknown> {
      // FedifyKvAdapter deliberately accepts numeric TTLs in addition to the
      // Fedify duration type. Keep the cast here at the integration seam so
      // the rest of the followers-sync service remains implementation-neutral.
      await kv.set([CACHE_NAMESPACE, key], value, { ttl: ttlSeconds as never });
      return undefined;
    },
  };
}

export class FedifyFollowersSyncSender implements FollowersSyncHeaderBuilder {
  /**
   * Coalesce only concurrent header builds for the same exact followers
   * collection and target origin. FollowersSyncService/Redis remains the TTL
   * cache and cross-process authority; this map exists solely to prevent an
   * in-process cache-miss stampede from issuing duplicate ActivityPods reads.
   *
   * The followers URI, rather than only the extracted actor identifier, is
   * part of the key because the serialized FEP header embeds collectionId.
   * Sharing a promise across distinct canonical actor URIs could otherwise
   * return a header carrying the wrong collectionId even when both URIs map to
   * the same local identifier.
   */
  private readonly inFlightHeaders = new Map<string, Promise<string | null>>();

  constructor(
    private readonly domain: string,
    private readonly service: Pick<FollowersSyncService, "buildSenderHeader">,
  ) {}

  async buildHeader(input: {
    actorUri: string;
    activity: string;
    targetInbox: string;
  }): Promise<string | null> {
    if (!isFollowersAddressedActivity(input.activity, input.actorUri)) return null;

    const actorIdentifier = extractActorIdentifier(input.actorUri, this.domain);
    if (!actorIdentifier) return null;

    const targetOrigin = extractOrigin(input.targetInbox);
    if (!targetOrigin) return null;

    const normalizedActorUri = input.actorUri.endsWith("/")
      ? input.actorUri.slice(0, -1)
      : input.actorUri;
    const followersUri = `${normalizedActorUri}/followers`;
    const coalescingKey = `${followersUri}\n${targetOrigin}`;

    const existing = this.inFlightHeaders.get(coalescingKey);
    if (existing) return existing;

    const pending = this.prepareHeader(
      actorIdentifier,
      followersUri,
      input.targetInbox,
    );
    this.inFlightHeaders.set(coalescingKey, pending);

    try {
      return await pending;
    } finally {
      // Do not let an older completion delete a newer promise if this code is
      // ever extended to replace entries before completion.
      if (this.inFlightHeaders.get(coalescingKey) === pending) {
        this.inFlightHeaders.delete(coalescingKey);
      }
    }
  }

  private async prepareHeader(
    actorIdentifier: string,
    followersUri: string,
    targetInbox: string,
  ): Promise<string | null> {
    try {
      return await this.service.buildSenderHeader(
        actorIdentifier,
        followersUri,
        targetInbox,
      );
    } catch (error) {
      logger.warn("[fep8fcf] Fedify outbound header preparation failed (non-fatal)", {
        actorIdentifier,
        targetInbox,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export function createFedifyFollowersSyncSender(
  kv: KvStore,
  config: FedifyFollowersSyncSenderConfig,
): FollowersSyncHeaderBuilder | null {
  if (!(config.enabled ?? process.env["ENABLE_FOLLOWERS_SYNC"] === "true")) return null;

  try {
    const service = new FollowersSyncService({
      domain: config.domain,
      activityPodsUrl: config.activityPodsUrl,
      activityPodsToken: config.activityPodsToken,
      requestTimeoutMs: config.requestTimeoutMs,
      userAgent: config.userAgent,
      redisCache: kvDigestCache(kv),
    });
    return new FedifyFollowersSyncSender(config.domain, service);
  } catch (error) {
    // FEP-8fcf is optional. A bad/missing authority configuration must not
    // disable ordinary ActivityPub delivery through the Fedify runtime.
    logger.warn("[fep8fcf] Fedify outbound sender disabled (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
