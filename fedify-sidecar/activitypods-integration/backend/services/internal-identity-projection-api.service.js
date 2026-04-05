"use strict";

const crypto = require("crypto");
const { Errors: WebErrors } = require("moleculer-web");
const { MoleculerError } = require("moleculer").Errors;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeCanonicalAccountId(value) {
  const sanitized = trimString(value);
  if (!sanitized || sanitized.length > 4096) return null;
  return sanitized;
}

function sanitizeDid(value) {
  const sanitized = trimString(value);
  if (!sanitized || sanitized.length > 512) return null;
  return sanitized;
}

function sanitizeHandle(value) {
  const sanitized = trimString(value).toLowerCase();
  if (!sanitized || sanitized.length > 253) return null;
  return sanitized;
}

function getBearerToken(req) {
  const raw = req && req.headers ? req.headers.authorization || req.headers.Authorization : "";
  if (!raw || typeof raw !== "string") return null;
  const [scheme, token] = raw.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token.trim();
}

function safeTokenEquals(expected, provided) {
  if (!expected || !provided) return false;
  const expectedBuf = Buffer.from(String(expected), "utf8");
  const providedBuf = Buffer.from(String(provided), "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = {
  name: "internal-identity-projection-api",

  dependencies: ["api", "internal-identity-projection"],

  settings: {
    auth: {
      bearerToken:
        process.env.ACTIVITYPODS_TOKEN || process.env.INTERNAL_API_TOKEN || "",
    },
    routePath: "/api/internal/identity",
  },

  async started() {
    const bearerToken = this.settings.auth.bearerToken;

    if (!bearerToken) {
      this.logger.warn(
        "[IdentityProjectionAPI] No internal bearer token configured; all requests will be rejected"
      );
    }

    await this.broker.call("api.addRoute", {
      route: {
        path: this.settings.routePath,
        authorization: false,
        authentication: false,
        bodyParsers: {
          json: false,
        },
        onBeforeCall(ctx, route, req) {
          const token = getBearerToken(req);
          if (!safeTokenEquals(bearerToken, token)) {
            throw new WebErrors.UnAuthorizedError(
              WebErrors.ERR_INVALID_TOKEN,
              null,
              "Unauthorized"
            );
          }
        },
        aliases: {
          "GET /by-canonical-account-id":
            "internal-identity-projection-api.byCanonicalAccountId",
          "GET /by-did": "internal-identity-projection-api.byDid",
          "GET /by-handle": "internal-identity-projection-api.byHandle",
        },
      },
    });

    this.logger.info(
      "[IdentityProjectionAPI] Routes registered",
      {
        routePath: this.settings.routePath,
      }
    );
  },

  actions: {
    byCanonicalAccountId: {
      async handler(ctx) {
        this.setNoStoreHeaders(ctx);

        const canonicalAccountId = sanitizeCanonicalAccountId(
          ctx.params.canonicalAccountId
        );
        if (!canonicalAccountId) {
          throw new MoleculerError(
            "canonicalAccountId is required",
            400,
            "INVALID_INPUT"
          );
        }

        const projection = await ctx.call(
          "internal-identity-projection.getByCanonicalAccountId",
          { canonicalAccountId }
        );

        return this.respondWithProjectionOr404(ctx, projection);
      },
    },

    byDid: {
      async handler(ctx) {
        this.setNoStoreHeaders(ctx);

        const atprotoDid = sanitizeDid(ctx.params.did || ctx.params.atprotoDid);
        if (!atprotoDid) {
          throw new MoleculerError("did is required", 400, "INVALID_INPUT");
        }

        const projection = await ctx.call("internal-identity-projection.getByDid", {
          atprotoDid,
        });

        return this.respondWithProjectionOr404(ctx, projection);
      },
    },

    byHandle: {
      async handler(ctx) {
        this.setNoStoreHeaders(ctx);

        const atprotoHandle = sanitizeHandle(
          ctx.params.handle || ctx.params.atprotoHandle
        );
        if (!atprotoHandle) {
          throw new MoleculerError("handle is required", 400, "INVALID_INPUT");
        }

        const projection = await ctx.call(
          "internal-identity-projection.getByHandle",
          { atprotoHandle }
        );

        return this.respondWithProjectionOr404(ctx, projection);
      },
    },
  },

  methods: {
    setNoStoreHeaders(ctx) {
      ctx.meta.$responseHeaders = {
        ...(ctx.meta.$responseHeaders || {}),
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      };
    },

    respondWithProjectionOr404(ctx, projection) {
      if (projection) {
        return projection;
      }

      ctx.meta.$statusCode = 404;
      return {
        error: "not_found",
        message: "Identity projection not found",
      };
    },
  },
};
