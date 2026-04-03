"use strict";

/**
 * Trusted ATProto -> ActivityPub bridge receiver.
 *
 * Accepts mirrored ActivityPub activities from the sidecar and posts them into
 * the local actor's outbox through ActivityPods' native ActivityPub services.
 *
 * Route: POST /api/internal/atproto-bridge/receive
 * Auth:  Bearer ${ACTIVITYPODS_TOKEN}
 */

const { Errors: E } = require("moleculer-web");

module.exports = {
  name: "sidecar.atproto-bridge-receiver",

  settings: {
    sidecarToken: process.env.ACTIVITYPODS_TOKEN || "",
  },

  async started() {
    const sidecarToken = this.settings.sidecarToken;

    if (!sidecarToken) {
      this.logger.warn("[AtprotoBridgeReceiver] ACTIVITYPODS_TOKEN is not set — all requests will be rejected");
    }

    await this.broker.call("api.addRoute", {
      route: {
        path: "/api/internal/atproto-bridge",
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
          "POST /receive": "sidecar.atproto-bridge-receiver.receive",
        },
      },
    });

    this.logger.info("[AtprotoBridgeReceiver] Route POST /api/internal/atproto-bridge/receive registered");
  },

  actions: {
    async receive(ctx) {
      const { actorUri, activity, bridge } = ctx.params;

      if (!actorUri || typeof actorUri !== "string") {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "actorUri is required" };
      }
      if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
        ctx.meta.$statusCode = 400;
        return { error: "invalid_request", message: "activity must be an object" };
      }

      const activityActorUri =
        typeof activity.actor === "string"
          ? activity.actor
          : (activity.actor && typeof activity.actor === "object" ? activity.actor.id : null);

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
      if (!actor?.outbox) {
        ctx.meta.$statusCode = 404;
        return { error: "not_found", message: "Local actor outbox could not be resolved" };
      }

      try {
        await ctx.call(
          "activitypub.outbox.post",
          {
            collectionUri: actor.outbox,
            ...activity,
          },
          {
            meta: {
              webId: actorUri,
              protocolBridge: bridge || null,
            },
          }
        );

        ctx.meta.$statusCode = 202;
        return { success: true };
      } catch (err) {
        this.logger.error("[AtprotoBridgeReceiver] Failed to post mirrored activity", {
          actorUri,
          activityId: activity.id,
          error: err.message,
        });

        ctx.meta.$statusCode = err.code === 404 || err.type === "NOT_FOUND" ? 404 : 500;
        return {
          success: false,
          error: "processing_error",
          message: err.message,
        };
      }
    },
  },
};
