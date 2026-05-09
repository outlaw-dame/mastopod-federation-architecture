"use strict";

const crypto = require("crypto");
const Redis = require("ioredis");

// ---------------------------------------------------------------------------
// Timing-safe bearer token comparison (CRIT-2)
// ---------------------------------------------------------------------------
const _HMAC_CMP_KEY = Buffer.alloc(32);
function safeTokenEqual(a, b) {
  const ha = crypto.createHmac("sha256", _HMAC_CMP_KEY).update(typeof a === "string" ? a : "").digest();
  const hb = crypto.createHmac("sha256", _HMAC_CMP_KEY).update(typeof b === "string" ? b : "").digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// ActivityPub actor URI resolution (HIGH-4)
// ActivityPub allows actor to be a string, an object with `id`, or an array.
// ---------------------------------------------------------------------------
function resolveActorUri(actor) {
  if (typeof actor === "string") return actor;
  if (Array.isArray(actor) && actor.length > 0) return resolveActorUri(actor[0]);
  if (actor && typeof actor === "object") {
    return typeof actor.id === "string" ? actor.id : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Activity deduplication (CRIT-5)
// TTL: 7 days — matches a reasonable federation replay-protection window.
// ---------------------------------------------------------------------------
const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

function dedupKey(activityId) {
  // SHA-256 the activity ID to keep Redis key lengths bounded regardless of
  // how long the remote activity ID URI is.
  const hash = crypto.createHash("sha256").update(String(activityId)).digest("hex");
  return `at:ap:dedup:${hash}`;
}

/**
 * Sidecar Inbox Receiver — Moleculer Service
 *
 * Receives verified inbound activities from the fedify-sidecar and forwards
 * them to ActivityPods via activitypub.inbox.post.
 *
 * The sidecar has already verified the HTTP signature, so we skip
 * signature validation and trust the verifiedActorUri.
 *
 * Route: POST /api/internal/inbox/receive
 * Auth:  Bearer ${ACTIVITYPODS_TOKEN}  (same secret as ACTIVITYPODS_TOKEN on the sidecar)
 */

const { Errors: E } = require("moleculer-web");

module.exports = {
  name: "sidecar.inbox-receiver",

  settings: {
    // Must match ACTIVITYPODS_TOKEN in the sidecar's environment.
    sidecarToken: process.env.ACTIVITYPODS_TOKEN || "",
    redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  },

  created() {
    this._redis = null;
  },

  async started() {
    const sidecarToken = this.settings.sidecarToken;

    if (!sidecarToken) {
      this.logger.warn("[SidecarInbox] ACTIVITYPODS_TOKEN is not set — all requests will be rejected");
    }

    // Dedicated Redis client for deduplication. Failures here are non-fatal
    // (we log and continue) to avoid blocking federation on Redis issues, but
    // the Redis connection error is surfaced as a structured log event.
    try {
      this._redis = new Redis(this.settings.redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
      });
      this._redis.on("error", (err) => {
        this.logger.error("[SidecarInbox] Redis dedup client error", { error: err.message });
      });
      await this._redis.connect();
      this.logger.info("[SidecarInbox] Redis dedup client connected");
    } catch (err) {
      this.logger.error("[SidecarInbox] Could not connect Redis dedup client — replay protection disabled", {
        error: err.message,
      });
      this._redis = null;
    }

    await this.broker.call("api.addRoute", {
      route: {
        path: "/api/internal/inbox",
        authorization: false,
        authentication: false,
        bodyParsers: { json: { strict: false } },
        onBeforeCall(ctx, route, req) {
          const authHeader = req.headers["authorization"] || "";
          const [scheme, token] = authHeader.split(" ");
          if (scheme !== "Bearer" || !sidecarToken || !safeTokenEqual(token, sidecarToken)) {
            throw new E.UnAuthorizedError(E.ERR_NO_TOKEN, null, "Invalid sidecar token");
          }
        },
        aliases: {
          "POST /receive": "sidecar.inbox-receiver.receive",
        },
      },
    });

    this.logger.info("[SidecarInbox] Route POST /api/internal/inbox/receive registered");
  },

  async stopped() {
    if (this._redis) {
      try { await this._redis.quit(); } catch { /* best-effort */ }
      this._redis = null;
    }
  },

  methods: {
    /**
     * Returns true if this activityId has NOT been seen before (and records it).
     * Returns true (allow) on Redis failure to avoid blocking federation.
     */
    async _checkAndMarkSeen(activityId) {
      if (!this._redis) return true; // Redis unavailable — fail open, already logged
      if (!activityId || typeof activityId !== "string") return true;
      try {
        const key = dedupKey(activityId);
        const result = await this._redis.set(key, "1", "EX", DEDUP_TTL_SEC, "NX");
        return result === "OK"; // "OK" = first time seen; null = duplicate
      } catch (err) {
        this.logger.warn("[SidecarInbox] Dedup Redis check failed — allowing activity", {
          error: err.message,
          activityId,
        });
        return true;
      }
    },
  },

  actions: {
    /**
     * Receive a verified inbound activity from the sidecar.
     *
     * Params: { targetInbox, activity, verifiedActorUri, receivedAt, remoteIp }
     */
    async receive(ctx) {
      const { targetInbox, activity, verifiedActorUri, receivedAt, remoteIp } = ctx.params;

      if (!targetInbox || typeof targetInbox !== "string") {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "targetInbox is required" };
      }
      if (!activity || typeof activity !== "object") {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "activity is required" };
      }
      if (!verifiedActorUri || typeof verifiedActorUri !== "string") {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "verifiedActorUri is required" };
      }
      if (!receivedAt || typeof receivedAt !== "number") {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "receivedAt must be a number (timestamp)" };
      }
      if (!remoteIp || typeof remoteIp !== "string") {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "remoteIp is required" };
      }

      // Resolve actor URI (handles string, object, and array forms).
      const activityActorUri = resolveActorUri(activity.actor);
      if (!activityActorUri || activityActorUri !== verifiedActorUri) {
        ctx.meta.$statusCode = 400;
        return { error: "actor_mismatch", message: "activity.actor does not match verifiedActorUri" };
      }

      // Deduplication — return 202 immediately for already-processed activities.
      const isNew = await this.methods._checkAndMarkSeen.call(this, activity.id);
      if (!isNew) {
        this.logger.debug("[SidecarInbox] Duplicate activity — skipping", {
          activityId: activity.id,
          verifiedActorUri,
        });
        ctx.meta.$statusCode = 202;
        return { success: true, deduplicated: true };
      }

      this.logger.info(
        `[SidecarInbox] ${activity.type} from ${verifiedActorUri} → ${targetInbox}`,
        { activityId: activity.id, remoteIp },
      );

      try {
        await ctx.call(
          "activitypub.inbox.post",
          { collectionUri: targetInbox, ...activity },
          { meta: { webId: verifiedActorUri, skipSignatureValidation: true } },
        );

        ctx.meta.$statusCode = 202;
        return { success: true };
      } catch (err) {
        this.logger.error("[SidecarInbox] Failed to deliver activity", {
          error: err.message,
          activityId: activity.id,
          targetInbox,
        });

        if (err.code === 404 || err.type === "NOT_FOUND") {
          ctx.meta.$statusCode = 404;
          return { success: false, error: "not_found" };
        }

        ctx.meta.$statusCode = 500;
        return { success: false, error: "processing_error" };
      }
    },
  },
};
