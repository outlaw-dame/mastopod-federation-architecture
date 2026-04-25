"use strict";

const { Errors: E } = require("moleculer-web");
const {
  getActivityActorUri,
  groupTargetsByDomain,
  normalizeUrl,
  resolveDeliveryTargets,
} = require("./activitypub-recipient-resolution");
const {
  ActivityResolutionError,
  parsePositiveInteger,
  resolveRemoteActivity,
} = require("./activitypub-activity-resolution");
const {
  AttachmentMediaResolutionError,
  resolveAttachmentMedia,
} = require("./activitypub-attachment-media-resolution");
const {
  ProfileMediaResolutionError,
  resolveProfileMedia,
} = require("./activitypub-profile-media-resolution");

module.exports = {
  name: "sidecar.activitypub-bridge-recipient-resolver",

  settings: {
    sidecarToken: process.env.ACTIVITYPODS_TOKEN || "",
    fetchTimeoutMs: parsePositiveInteger(
      process.env.PROTOCOL_BRIDGE_ACTIVITY_RESOLUTION_TIMEOUT_MS,
      10_000,
    ),
    maxResponseBytes: parsePositiveInteger(
      process.env.PROTOCOL_BRIDGE_ACTIVITY_RESOLUTION_MAX_BYTES,
      256_000,
    ),
    maxProfileMediaBytes: parsePositiveInteger(
      process.env.PROTOCOL_BRIDGE_PROFILE_MEDIA_MAX_BYTES,
      5 * 1024 * 1024,
    ),
    maxAttachmentMediaBytes: parsePositiveInteger(
      process.env.PROTOCOL_BRIDGE_ATTACHMENT_MEDIA_MAX_BYTES,
      50 * 1024 * 1024,
    ),
  },

  async started() {
    const sidecarToken = this.settings.sidecarToken;

    if (!sidecarToken) {
      this.logger.warn("[ActivityPubBridgeRecipientResolver] ACTIVITYPODS_TOKEN is not set — all requests will be rejected");
    }

    await this.broker.call("api.addRoute", {
      route: {
        path: "/api/internal/activitypub-bridge",
        authorization: false,
        authentication: false,
        bodyParsers: { json: { strict: false } },
        onBeforeCall(_ctx, _route, req) {
          const authHeader = req.headers["authorization"] || "";
          const [scheme, token] = authHeader.split(" ");
          if (scheme !== "Bearer" || !sidecarToken || token !== sidecarToken) {
            throw new E.UnAuthorizedError(E.ERR_NO_TOKEN, null, "Invalid sidecar token");
          }
        },
        aliases: {
          "POST /resolve-outbound": "sidecar.activitypub-bridge-recipient-resolver.resolveOutbound",
          "POST /resolve-activity": "sidecar.activitypub-bridge-recipient-resolver.resolveActivity",
          "POST /resolve-media": "sidecar.activitypub-bridge-recipient-resolver.resolveMedia",
          "POST /resolve-profile-media": "sidecar.activitypub-bridge-recipient-resolver.resolveProfileMedia",
        },
      },
    });

    this.logger.info("[ActivityPubBridgeRecipientResolver] Routes POST /api/internal/activitypub-bridge/{resolve-outbound,resolve-activity,resolve-media,resolve-profile-media} registered");
  },

  actions: {
    async resolveMedia(ctx) {
      const mediaUrl = normalizeUrl(ctx.params?.mediaUrl);

      if (!mediaUrl) {
        ctx.meta.$statusCode = 400;
        return {
          error: "invalid_request",
          message: "mediaUrl must be a valid https URL or localhost http URL",
        };
      }

      try {
        const resolved = await resolveAttachmentMedia({
          mediaUrl,
          timeoutMs: this.settings.fetchTimeoutMs,
          maxResponseBytes: this.settings.maxAttachmentMediaBytes,
        });

        ctx.meta.$statusCode = 200;
        return {
          ...resolved,
          resolvedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof AttachmentMediaResolutionError) {
          this.logger.warn("[ActivityPubBridgeRecipientResolver] Attachment media resolution rejected", {
            mediaUrl,
            code: error.code,
            statusCode: error.statusCode,
            error: error.message,
          });

          ctx.meta.$statusCode = error.statusCode;
          return {
            error: error.code,
            message: error.message,
          };
        }

        this.logger.error("[ActivityPubBridgeRecipientResolver] Unexpected attachment media resolution failure", {
          mediaUrl,
          error: error?.message || String(error),
        });

        ctx.meta.$statusCode = 500;
        return {
          error: "processing_error",
          message: "Unexpected attachment media resolution failure",
        };
      }
    },

    async resolveProfileMedia(ctx) {
      const mediaUrl = normalizeUrl(ctx.params?.mediaUrl);

      if (!mediaUrl) {
        ctx.meta.$statusCode = 400;
        return {
          error: "invalid_request",
          message: "mediaUrl must be a valid https URL or localhost http URL",
        };
      }

      try {
        const resolved = await resolveProfileMedia({
          mediaUrl,
          timeoutMs: this.settings.fetchTimeoutMs,
          maxResponseBytes: this.settings.maxProfileMediaBytes,
        });

        ctx.meta.$statusCode = 200;
        return {
          ...resolved,
          resolvedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof ProfileMediaResolutionError) {
          this.logger.warn("[ActivityPubBridgeRecipientResolver] Profile media resolution rejected", {
            mediaUrl,
            code: error.code,
            statusCode: error.statusCode,
            error: error.message,
          });

          ctx.meta.$statusCode = error.statusCode;
          return {
            error: error.code,
            message: error.message,
          };
        }

        this.logger.error("[ActivityPubBridgeRecipientResolver] Unexpected profile media resolution failure", {
          mediaUrl,
          error: error?.message || String(error),
        });

        ctx.meta.$statusCode = 500;
        return {
          error: "processing_error",
          message: "Unexpected profile media resolution failure",
        };
      }
    },

    async resolveActivity(ctx) {
      const activityId = normalizeUrl(ctx.params?.activityId);
      const expectedActorUri = ctx.params?.expectedActorUri == null
        ? null
        : normalizeUrl(ctx.params.expectedActorUri);

      if (!activityId) {
        ctx.meta.$statusCode = 400;
        return {
          error: "invalid_request",
          message: "activityId must be a valid https URL or localhost http URL",
        };
      }

      if (ctx.params?.expectedActorUri != null && !expectedActorUri) {
        ctx.meta.$statusCode = 400;
        return {
          error: "invalid_request",
          message: "expectedActorUri must be a valid https URL or localhost http URL",
        };
      }

      try {
        const activity = await resolveRemoteActivity({
          activityId,
          expectedActorUri,
          timeoutMs: this.settings.fetchTimeoutMs,
          maxResponseBytes: this.settings.maxResponseBytes,
        });

        ctx.meta.$statusCode = 200;
        return {
          activityId,
          activity,
          resolvedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof ActivityResolutionError) {
          this.logger.warn("[ActivityPubBridgeRecipientResolver] Activity resolution rejected", {
            activityId,
            expectedActorUri,
            code: error.code,
            statusCode: error.statusCode,
            error: error.message,
          });

          ctx.meta.$statusCode = error.statusCode;
          return {
            error: error.code,
            message: error.message,
          };
        }

        this.logger.error("[ActivityPubBridgeRecipientResolver] Unexpected activity resolution failure", {
          activityId,
          expectedActorUri,
          error: error?.message || String(error),
        });

        ctx.meta.$statusCode = 500;
        return {
          error: "processing_error",
          message: "Unexpected activity resolution failure",
        };
      }
    },

    async resolveOutbound(ctx) {
      const { actorUri, activity } = ctx.params;

      if (!actorUri || typeof actorUri !== "string") {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "actorUri is required" };
      }
      if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "activity must be an object" };
      }

      const activityActorUri = getActivityActorUri(activity);
      if (!activityActorUri || activityActorUri !== actorUri) {
        ctx.meta.$statusCode = 400;
        return { error: "actor_mismatch", message: "activity.actor does not match actorUri" };
      }

      const isLocal = await ctx.call("activitypub.actor.isLocal", { actorUri });
      if (!isLocal) {
        ctx.meta.$statusCode = 403;
        return { error: "forbidden", message: "actorUri is not hosted locally" };
      }

      const actor = await ctx.call("activitypub.actor.get", { actorUri });
      if (!actor) {
        ctx.meta.$statusCode = 404;
        return { error: "not_found", message: "Local actor could not be resolved" };
      }

      try {
        const targets = await resolveDeliveryTargets({
          ctx,
          actorUri,
          actor,
          activity,
          logger: this.logger,
        });
        const deliveries = groupTargetsByDomain(actorUri, targets);

        ctx.meta.$statusCode = 200;
        return {
          actorUri,
          deliveries,
          resolvedAt: new Date().toISOString(),
        };
      } catch (err) {
        this.logger.error("[ActivityPubBridgeRecipientResolver] Failed to resolve outbound recipients", {
          actorUri,
          activityId: activity.id,
          error: err.message,
        });

        ctx.meta.$statusCode = 500;
        return {
          error: "processing_error",
          message: err.message,
        };
      }
    },
  },
};
