/**
 * ApRelaySubscriptionService
 *
 * Manages ActivityPub relay subscriptions using the ActivityRelay / LitePub
 * relay protocol:
 *
 *   1. On startup (and every resubscribeIntervalMs), send a signed Follow
 *      activity to each configured relay actor.
 *   2. The relay responds with Accept{Follow} (handled by the normal inbound
 *      pipeline — no special Accept wiring required here).
 *   3. The relay then delivers Announce{object} activities to the sidecar's
 *      shared inbox.  Fedify's inbox listener verifies the HTTP signature and
 *      routes the Announce into the Redis Streams inbound queue, where the
 *      inbound worker forwards it to ActivityPods and publishes it to Stream2
 *      for search indexing.  No additional inbound plumbing is needed.
 *
 * Relay actor URL format (ActivityRelay / LitePub standard):
 *   https://relay.example.com/actor
 *
 * Configured via the AP_RELAY_ACTOR_URLS environment variable
 * (comma-separated list of relay actor URLs).
 *
 * Security notes:
 *   - Relay actor URLs are validated: must be https, no credentials, no
 *     private-IP hosts.
 *   - The Follow activity JSON never embeds secrets; it is signed downstream
 *     by ActivityPods via the outbound queue.
 *   - Fetch errors, actor-document parse failures, and queue errors are all
 *     non-fatal — relay subscription must never block or crash the sidecar.
 */

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Redis } from "ioredis";
import {
  createOutboxIntent,
  type RedisStreamsQueue,
} from "../../queue/sidecar-redis-queue.js";
import { metrics } from "../../metrics/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApRelaySubscriptionConfig {
  /** Validated relay actor URLs to follow. */
  relayActorUrls: string[];
  /**
   * The local ActivityPub actor URI used as the Follow sender.
   * Must be an actor whose private key is held by ActivityPods so the
   * outbound worker can sign the delivery.
   */
  localActorUri: string;
  /** Public domain of this sidecar (used to mint activity IDs). */
  domain: string;
  /**
   * How often (ms) to re-check and re-send Follow activities to relays
   * that haven't been followed recently.
   * Default: 24 hours.
   */
  resubscribeIntervalMs?: number;
  /**
   * How long (ms) after a Follow is sent before the relay is considered
   * stale and should be re-followed.
   * Default: 23 hours (slightly less than resubscribeInterval so there is
   * always a re-follow window).
   */
  followStalenessMs?: number;
  /**
   * Maximum number of actor-document fetch attempts before a relay is
   * placed in exponential-backoff hold.
   * Default: 5.
   */
  maxFetchAttempts?: number;
  /** User-Agent for outbound HTTP requests to fetch relay actor documents. */
  userAgent?: string;
  /** Timeout (ms) for fetching a relay actor document. Default: 10 000. */
  actorFetchTimeoutMs?: number;
}

export interface ApRelaySubscriptionLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

interface RelayState {
  lastFollowAt: number;
  errorCount: number;
  lastErrorAt: number;
  nextRetryAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RESUBSCRIBE_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24 h
const DEFAULT_FOLLOW_STALENESS_MS = 23 * 60 * 60 * 1_000;     // 23 h
const DEFAULT_MAX_FETCH_ATTEMPTS = 5;
const DEFAULT_ACTOR_FETCH_TIMEOUT_MS = 10_000;

const REDIS_KEY_PREFIX = "ap:relay:state:";
const REDIS_STATE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Base delay for backoff: 5 min → 10 → 20 → 40 → 80 → max 4 h */
const BACKOFF_BASE_MS = 5 * 60 * 1_000;
const BACKOFF_MAX_MS = 4 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function isPrivateLiteralIp(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const octets = hostname.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const a = octets[0] as number;
    const b = octets[1] as number;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (version === 6) {
    const n = hostname.toLowerCase();
    return n === "::1" || n.startsWith("fc") || n.startsWith("fd") || n.startsWith("fe80:");
  }
  return false;
}

/**
 * Validate and normalise a relay actor URL.
 * Returns null if the URL is invalid or unsafe.
 */
export function validateRelayActorUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "::1") return null;
  if (isPrivateLiteralIp(host)) return null;
  u.hash = "";
  return u;
}

/**
 * Parse AP_RELAY_ACTOR_URLS (comma-separated) and return the deduplicated,
 * validated set of relay actor URLs.
 */
export function parseRelayActorUrls(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of raw.split(",")) {
    const validated = validateRelayActorUrl(segment);
    if (!validated) continue;
    const href = validated.href;
    if (seen.has(href)) continue;
    seen.add(href);
    result.push(href);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ApRelaySubscriptionService {
  private readonly relayActorUrls: string[];
  private readonly localActorUri: string;
  private readonly domain: string;
  private readonly resubscribeIntervalMs: number;
  private readonly followStalenessMs: number;
  private readonly maxFetchAttempts: number;
  private readonly userAgent: string;
  private readonly actorFetchTimeoutMs: number;
  private readonly redis: Redis;
  private readonly queue: RedisStreamsQueue;
  private readonly logger: ApRelaySubscriptionLogger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    redis: Redis,
    queue: RedisStreamsQueue,
    config: ApRelaySubscriptionConfig,
    logger?: ApRelaySubscriptionLogger,
  ) {
    this.redis = redis;
    this.queue = queue;
    this.localActorUri = config.localActorUri;
    this.domain = config.domain;
    this.relayActorUrls = config.relayActorUrls;
    this.resubscribeIntervalMs = config.resubscribeIntervalMs ?? DEFAULT_RESUBSCRIBE_INTERVAL_MS;
    this.followStalenessMs = config.followStalenessMs ?? DEFAULT_FOLLOW_STALENESS_MS;
    this.maxFetchAttempts = config.maxFetchAttempts ?? DEFAULT_MAX_FETCH_ATTEMPTS;
    this.userAgent = config.userAgent ?? "Fedify-Sidecar/1.0 (ActivityPods) relay-subscriber";
    this.actorFetchTimeoutMs = config.actorFetchTimeoutMs ?? DEFAULT_ACTOR_FETCH_TIMEOUT_MS;
    this.logger = logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
  }

  /**
   * Start the relay subscription service.
   *
   * Sends Follow activities to all configured relays immediately, then
   * schedules a periodic re-subscription check.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.relayActorUrls.length === 0) {
      this.logger.info("[relay] No relay actor URLs configured — relay subscription inactive");
      return;
    }

    this.logger.info("[relay] Starting relay subscription service", {
      relayCount: this.relayActorUrls.length,
      localActorUri: this.localActorUri,
      resubscribeIntervalMs: this.resubscribeIntervalMs,
    });

    // Initial subscription pass — run async so startup is not blocked.
    this.runSubscriptionPass().catch((err) => {
      this.logger.error("[relay] Initial subscription pass error", { err: String(err) });
    });

    // Periodic re-subscription.
    this.timer = setInterval(() => {
      this.runSubscriptionPass().catch((err) => {
        this.logger.error("[relay] Periodic subscription pass error", { err: String(err) });
      });
    }, this.resubscribeIntervalMs);

    // Allow Node to exit even if this timer is still running.
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /** Stop the periodic re-subscription timer. */
  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  // --------------------------------------------------------------------------
  // Internal: subscription pass
  // --------------------------------------------------------------------------

  /**
   * For each configured relay actor URL, check if a Follow should be sent
   * (either first-time or stale) and, if so, send it.
   */
  private async runSubscriptionPass(): Promise<void> {
    const now = Date.now();
    for (const relayActorUrl of this.relayActorUrls) {
      try {
        await this.maybeSubscribe(relayActorUrl, now);
      } catch (err) {
        // Per-relay errors must never abort the pass.
        this.logger.error("[relay] Unexpected error for relay in subscription pass", {
          relayActorUrl,
          err: String(err),
        });
      }
    }
  }

  private async maybeSubscribe(relayActorUrl: string, now: number): Promise<void> {
    const state = await this.loadState(relayActorUrl);

    // Backoff: relay has errored too many times recently — skip until nextRetryAt.
    if (state.nextRetryAt > now) {
      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "backoff_skip" });
      this.logger.info("[relay] Relay in backoff window, skipping", {
        relayActorUrl,
        retryAt: new Date(state.nextRetryAt).toISOString(),
      });
      return;
    }

    // Already followed recently and not stale — skip.
    if (state.lastFollowAt > 0 && now - state.lastFollowAt < this.followStalenessMs) {
      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "fresh_skip" });
      this.logger.info("[relay] Relay follow is still fresh, skipping", {
        relayActorUrl,
        followAge: now - state.lastFollowAt,
      });
      return;
    }

    // Fetch relay actor document to get inbox URL.
    const inboxUrl = await this.fetchRelayInbox(relayActorUrl, state, now);
    if (!inboxUrl) return; // state already updated by fetchRelayInbox

    // Enqueue Follow activity via the outbound intent queue.
    const enqueued = await this.enqueueFollow(relayActorUrl, inboxUrl);
    if (!enqueued) return;

    metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "follow_enqueued" });

    // Mark follow as sent.
    await this.saveState(relayActorUrl, {
      lastFollowAt: now,
      errorCount: 0,
      lastErrorAt: state.lastErrorAt,
      nextRetryAt: 0,
    });

    this.logger.info("[relay] Enqueued Follow to relay", { relayActorUrl, inboxUrl });
  }

  // --------------------------------------------------------------------------
  // Internal: actor document fetch
  // --------------------------------------------------------------------------

  /**
   * Fetch the relay actor document and return its inbox URL.
   * Returns null on any error and updates state accordingly.
   */
  private async fetchRelayInbox(
    relayActorUrl: string,
    state: RelayState,
    now: number,
  ): Promise<string | null> {
    let doc: Record<string, unknown>;
    try {
      const resp = await fetch(relayActorUrl, {
        headers: {
          Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
          "User-Agent": this.userAgent,
        },
        signal: AbortSignal.timeout(this.actorFetchTimeoutMs),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      doc = (await resp.json()) as Record<string, unknown>;
    } catch (err) {
      const newErrorCount = state.errorCount + 1;
      const backoffMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, newErrorCount - 1),
        BACKOFF_MAX_MS,
      );
      const nextRetryAt = now + backoffMs;

      this.logger.warn("[relay] Failed to fetch relay actor document", {
        relayActorUrl,
        err: String(err),
        errorCount: newErrorCount,
        nextRetryIn: `${Math.round(backoffMs / 60_000)} min`,
      });

      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "fetch_failed" });

      await this.saveState(relayActorUrl, {
        ...state,
        errorCount: newErrorCount,
        lastErrorAt: now,
        nextRetryAt,
      });
      return null;
    }

    // Extract inbox URL. The AP spec puts it at the top-level "inbox" key.
    const inbox = doc["inbox"];
    if (typeof inbox !== "string" || inbox.length === 0) {
      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "invalid_inbox" });
      this.logger.warn("[relay] Relay actor document has no inbox URL", {
        relayActorUrl,
        docKeys: Object.keys(doc).slice(0, 10),
      });
      return null;
    }

    // Validate inbox URL: must be https, no credentials, no private IPs.
    let inboxUrl: URL;
    try {
      inboxUrl = new URL(inbox);
    } catch {
      this.logger.warn("[relay] Relay inbox URL is not a valid URL", {
        relayActorUrl,
        inbox,
      });
      return null;
    }
    if (inboxUrl.protocol !== "https:") {
      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "invalid_inbox" });
      this.logger.warn("[relay] Relay inbox URL is not https", { relayActorUrl, inbox });
      return null;
    }
    if (inboxUrl.username || inboxUrl.password) {
      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "invalid_inbox" });
      this.logger.warn("[relay] Relay inbox URL contains credentials", { relayActorUrl });
      return null;
    }
    if (isPrivateLiteralIp(inboxUrl.hostname.toLowerCase())) {
      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "invalid_inbox" });
      this.logger.warn("[relay] Relay inbox URL resolves to private IP", { relayActorUrl });
      return null;
    }

    return inboxUrl.href;
  }

  // --------------------------------------------------------------------------
  // Internal: enqueue Follow
  // --------------------------------------------------------------------------

  private async enqueueFollow(relayActorUrl: string, inboxUrl: string): Promise<boolean> {
    const activityId = `https://${this.domain}/relay-subscriptions/${randomUUID()}`;

    const followActivity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: activityId,
      type: "Follow",
      actor: this.localActorUri,
      object: relayActorUrl,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    };

    const inboxParsed = new URL(inboxUrl);
    const intent = createOutboxIntent({
      activityId,
      actorUri: this.localActorUri,
      activity: JSON.stringify(followActivity),
      targets: [
        {
          inboxUrl,
          deliveryUrl: inboxUrl,
          targetDomain: inboxParsed.hostname,
        },
      ],
      meta: {
        visibility: "public",
        isPublicIndexable: false,
      },
    });

    try {
      await this.queue.enqueueOutboxIntent(intent);
      return true;
    } catch (err) {
      metrics.apRelaySubscriptionAttempts.inc({ relay: relayActorUrl, status: "enqueue_failed" });
      this.logger.error("[relay] Failed to enqueue Follow activity", {
        relayActorUrl,
        inboxUrl,
        err: String(err),
      });
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Internal: Redis state
  // --------------------------------------------------------------------------

  private redisKey(relayActorUrl: string): string {
    return `${REDIS_KEY_PREFIX}${Buffer.from(relayActorUrl).toString("base64url")}`;
  }

  private async loadState(relayActorUrl: string): Promise<RelayState> {
    const blank: RelayState = { lastFollowAt: 0, errorCount: 0, lastErrorAt: 0, nextRetryAt: 0 };
    try {
      const raw = await this.redis.get(this.redisKey(relayActorUrl));
      if (!raw) return blank;
      const parsed = JSON.parse(raw) as Partial<RelayState>;
      return {
        lastFollowAt: parsed.lastFollowAt ?? 0,
        errorCount: parsed.errorCount ?? 0,
        lastErrorAt: parsed.lastErrorAt ?? 0,
        nextRetryAt: parsed.nextRetryAt ?? 0,
      };
    } catch {
      return blank;
    }
  }

  private async saveState(relayActorUrl: string, state: RelayState): Promise<void> {
    try {
      await this.redis.set(
        this.redisKey(relayActorUrl),
        JSON.stringify(state),
        "EX",
        REDIS_STATE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.error("[relay] Failed to persist relay state", {
        relayActorUrl,
        err: String(err),
      });
    }
  }
}
