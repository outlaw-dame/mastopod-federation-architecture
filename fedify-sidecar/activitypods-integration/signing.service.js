// services/signing.service.js
// ActivityPods Signing Service - Formal Contract Implementation
// Implements signing.signHttpRequestsBatch as per Fediverse interop baseline (Cavage-style HTTP Signatures)
"use strict";

const crypto = require("crypto");
const { URL } = require("url");
const { MoleculerError } = require("moleculer").Errors;

// ============================================================================
// Utility Functions
// ============================================================================

function toHttpDate(d = new Date()) {
  return d.toUTCString(); // IMF-fixdate format
}

function assertHost(host) {
  if (!host || typeof host !== "string") return false;
  if (host.includes("://")) return false;
  if (host.includes("/")) return false;
  if (/\s/.test(host)) return false;
  return true;
}

function assertPath(path) {
  return typeof path === "string" && path.startsWith("/");
}

function sha256Base64(buf) {
  return crypto.createHash("sha256").update(buf).digest("base64");
}

function digestHeaderFromBytes(buf) {
  return `SHA-256=${sha256Base64(buf)}`;
}

function normalizeMethod(m) {
  return String(m || "").toUpperCase();
}

function buildRequestTarget(method, path, query) {
  const q = query ? String(query) : "";
  const qp = q ? (q.startsWith("?") ? q : `?${q}`) : "";
  return `${method.toLowerCase()} ${path}${qp}`;
}

/**
 * Build the Cavage-style signing string from covered headers.
 * Header names MUST be lowercase; order MUST match headers="..." parameter.
 */
function buildSigningString({ requestTarget, host, date, digest, contentType }, signedHeaders) {
  const lines = [];
  for (const h of signedHeaders) {
    const hl = h.toLowerCase();
    if (hl === "(request-target)") lines.push(`(request-target): ${requestTarget}`);
    else if (hl === "host") lines.push(`host: ${host}`);
    else if (hl === "date") lines.push(`date: ${date}`);
    else if (hl === "digest") lines.push(`digest: ${digest}`);
    else if (hl === "content-type") lines.push(`content-type: ${contentType}`);
    else {
      // Fail closed: don't sign unknown headers by accident
      throw new Error(`PROFILE_INVALID: unsupported signed header: ${h}`);
    }
  }
  return lines.join("\n");
}

function signRsaSha256(privateKeyPem, signingString) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingString);
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

// ============================================================================
// Moleculer Service
// ============================================================================

module.exports = {
  name: "signing",

  dependencies: ["keys", "activitypub.actor", "actors"],

  settings: {
    auth: {
      bearerToken: process.env.SIGNING_API_TOKEN || "",
      // Strong recommendation: also enforce mTLS at the reverse proxy / mesh
    },
    limits: {
      maxBatch: Number(process.env.SIGNING_MAX_BATCH || 500),
      maxBodyBytes: Number(process.env.SIGNING_MAX_BODY_BYTES || 512 * 1024),
      maxClockSkewSeconds: Number(process.env.SIGNING_MAX_SKEW_SECONDS || 300),
    },
    // Signing profiles aligned with Fediverse practice (GoToSocial/Mastodon baseline)
    profiles: {
      ap_get_v1: {
        algorithm: "rsa-sha256",
        signedHeaders: ["(request-target)", "host", "date"],
        requireDigest: false,
        signContentType: false,
      },
      ap_post_v1: {
        algorithm: "rsa-sha256",
        signedHeaders: ["(request-target)", "host", "date", "digest"],
        requireDigest: true,
        signContentType: false,
      },
      ap_post_v1_ct: {
        algorithm: "rsa-sha256",
        signedHeaders: ["(request-target)", "host", "date", "digest", "content-type"],
        requireDigest: true,
        signContentType: true,
      },
    },
  },

  actions: {
    /**
     * Batch sign HTTP requests for ActivityPub federation.
     * 
     * This is the formal contract endpoint that allows the Fedify sidecar to
     * request signatures for outbound HTTP requests while keeping all private
     * keys inside ActivityPods.
     * 
     * @param {Object} ctx - Moleculer context
     * @param {Array} ctx.params.requests - Array of signing requests
     * @returns {Object} Results with signed headers or errors per request
     */
    signHttpRequestsBatch: {
      rest: {
        method: "POST",
        path: "/api/internal/signatures/batch",
      },
      params: {
        requests: { type: "array", min: 1 },
        options: {
          type: "object",
          optional: true,
          props: {
            maxPerBatch: { type: "number", optional: true },
            failClosedIfActorUnknown: { type: "boolean", optional: true, default: true },
          },
        },
      },

      async handler(ctx) {
        this._auth(ctx);

        const reqs = ctx.params.requests;
        if (reqs.length > this.settings.limits.maxBatch) {
          return {
            results: reqs.map(r => ({
              requestId: r?.requestId,
              ok: false,
              error: {
                code: "INVALID_INPUT",
                message: `maxBatch=${this.settings.limits.maxBatch} exceeded`,
                retryable: false,
              },
            })),
          };
        }

        // Group by actor for key reuse + locality checks
        const byActor = new Map();
        for (const r of reqs) {
          const a = r?.actorUri || "";
          if (!byActor.has(a)) byActor.set(a, []);
          byActor.get(a).push(r);
        }

        const results = [];

        for (const [actorUri, items] of byActor) {
          // Validate local actor (authority boundary enforcement)
          const locality = await this._validateLocalActor(ctx, actorUri);
          if (!locality.ok) {
            for (const r of items) {
              results.push(this._err(r, locality.error, locality.message, false));
            }
            continue;
          }

          // Resolve private key (authority remains here - keys never leave ActivityPods)
          let keyPair;
          try {
            // Resolve actorUri -> webId if they differ in your stack
            const webId = await ctx.call("actors.resolveWebIdForActor", { actorUri });
            keyPair = await ctx.call("keys.getOrCreateWebIdKeys", { webId });
          } catch (e) {
            for (const r of items) {
              results.push(this._err(r, "KEY_UNAVAILABLE", e?.message || "key lookup failed", true));
            }
            continue;
          }

          if (!keyPair?.privateKey) {
            for (const r of items) {
              results.push(this._err(r, "KEY_UNAVAILABLE", "privateKey missing", true));
            }
            continue;
          }

          // Resolve keyId authoritatively (signer-controlled, NOT hardcoded by caller)
          let keyId;
          try {
            keyId = await ctx.call("actors.getPublicKeyId", { actorUri });
          } catch (e) {
            for (const r of items) {
              results.push(this._err(r, "KEY_UNAVAILABLE", e?.message || "keyId lookup failed", true));
            }
            continue;
          }

          // Sign each request in this actor's batch
          for (const r of items) {
            results.push(await this._signOne(ctx, actorUri, keyId, keyPair.privateKey, r));
          }
        }

        return { results };
      },
    },
  },

  methods: {
    /**
     * Authenticate the request using bearer token.
     * This endpoint is internal-only and MUST be protected.
     */
    _auth(ctx) {
      const auth = ctx.meta?.$headers?.authorization || ctx.meta?.$headers?.Authorization;
      if (!auth || !String(auth).startsWith("Bearer ")) {
        throw new MoleculerError("Missing bearer token", 401, "AUTH_FAILED");
      }
      const token = String(auth).slice(7);
      if (!this.settings.auth.bearerToken || token !== this.settings.auth.bearerToken) {
        throw new MoleculerError("Invalid bearer token", 403, "AUTH_FAILED");
      }
    },

    /**
     * Create an error response for a signing request.
     */
    _err(r, code, message, retryable) {
      return {
        requestId: r?.requestId,
        ok: false,
        error: { code, message, retryable },
      };
    },

    /**
     * Validate that the actorUri is a local actor controlled by this ActivityPods deployment.
     * This is the critical authority boundary enforcement.
     */
    async _validateLocalActor(ctx, actorUri) {
      if (!actorUri || typeof actorUri !== "string") {
        return { ok: false, error: "INVALID_INPUT", message: "actorUri missing" };
      }
      try {
        new URL(actorUri);
      } catch {
        return { ok: false, error: "INVALID_INPUT", message: "actorUri not a URL" };
      }

      // Strong enforcement: verify actor is local to this deployment
      try {
        const isLocal = await ctx.call("activitypub.actor.isLocal", { actorUri });
        if (!isLocal) {
          return { ok: false, error: "ACTOR_NOT_LOCAL", message: "actorUri not local" };
        }
      } catch {
        return { ok: false, error: "ACTOR_NOT_LOCAL", message: "locality verification unavailable" };
      }

      return { ok: true };
    },

    /**
     * Parse body bytes from the request.
     * Body must be the exact serialized bytes that will be transmitted.
     */
    _parseBodyBytes(r) {
      const body = r?.body;
      if (!body) return null;

      const bytesStr = body?.bytes;
      if (typeof bytesStr !== "string") return null;
      return Buffer.from(bytesStr, body?.encoding === "utf8" ? "utf8" : "utf8");
    },

    /**
     * Validate date skew to prevent replay attacks.
     */
    _validateDateSkew(dateStr) {
      const t = Date.parse(dateStr);
      if (Number.isNaN(t)) return true; // Let unparseable dates through
      const now = Date.now();
      const skewMs = Math.abs(now - t);
      return skewMs <= this.settings.limits.maxClockSkewSeconds * 1000;
    },

    /**
     * Sign a single HTTP request.
     * Returns signed headers or error.
     */
    async _signOne(ctx, actorUri, keyId, privateKeyPem, r) {
      try {
        const requestId = r?.requestId;
        const method = normalizeMethod(r?.method);
        const profileName = r?.profile;

        const profile = this.settings.profiles[profileName];
        if (!profile) {
          return this._err(r, "PROFILE_NOT_ALLOWED", `unknown profile: ${profileName}`, false);
        }

        const host = r?.target?.host;
        const path = r?.target?.path;
        const query = r?.target?.query || "";

        // Validate required fields
        if (!assertHost(host)) {
          return this._err(r, "INVALID_INPUT", "target.host invalid", false);
        }
        if (!assertPath(path)) {
          return this._err(r, "INVALID_INPUT", "target.path invalid", false);
        }
        if (!method || !["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) {
          return this._err(r, "INVALID_INPUT", "method invalid", false);
        }

        // Handle date: use provided or generate
        let date = r?.headers?.date;
        if (!date) {
          date = toHttpDate();
        }
        if (!this._validateDateSkew(date)) {
          return this._err(r, "INVALID_INPUT", "date skew too large", false);
        }

        // Handle digest for POST/PUT requests
        let digest = null;
        let bodySha256Base64 = null;

        if (profile.requireDigest) {
          const digestMode = r?.digest?.mode || "server_compute";

          if (digestMode === "server_compute") {
            // Preferred: sidecar provides body bytes, we compute digest
            const bodyBuf = this._parseBodyBytes(r);
            if (!bodyBuf) {
              return this._err(r, "INVALID_INPUT", "body.bytes required for POST profile", false);
            }
            if (bodyBuf.length > this.settings.limits.maxBodyBytes) {
              return this._err(r, "BODY_TOO_LARGE", `body exceeds ${this.settings.limits.maxBodyBytes} bytes`, false);
            }
            bodySha256Base64 = sha256Base64(bodyBuf);
            digest = `SHA-256=${bodySha256Base64}`;
          } else if (digestMode === "caller_provided_strict") {
            // Caller provides digest; we MUST verify it matches the body
            const providedDigest = r?.digest?.value;
            const providedBodyHash = r?.digest?.bodyHashSha256Base64;
            const bodyBuf = this._parseBodyBytes(r);

            if (!providedDigest || !bodyBuf) {
              return this._err(r, "INVALID_INPUT", "digest.value and body.bytes required for caller_provided_strict", false);
            }

            // Verify the provided digest matches the body
            const computedHash = sha256Base64(bodyBuf);
            if (providedBodyHash && providedBodyHash !== computedHash) {
              return this._err(r, "DIGEST_MISMATCH", "provided bodyHashSha256Base64 does not match body", false);
            }

            const expectedDigest = `SHA-256=${computedHash}`;
            if (providedDigest !== expectedDigest) {
              return this._err(r, "DIGEST_MISMATCH", "provided digest does not match computed digest", false);
            }

            digest = providedDigest;
            bodySha256Base64 = computedHash;
          } else {
            return this._err(r, "INVALID_INPUT", `unknown digest.mode: ${digestMode}`, false);
          }
        }

        // Get content-type if needed for signing
        const contentType = r?.headers?.contentType || "application/activity+json";

        // Build the request target
        const requestTarget = buildRequestTarget(method, path, query);

        // Build the signing string
        const signingString = buildSigningString(
          { requestTarget, host, date, digest, contentType },
          profile.signedHeaders
        );

        // Sign with RSA-SHA256
        const signature = signRsaSha256(privateKeyPem, signingString);

        // Build the Signature header (Cavage-style)
        const signedHeadersList = profile.signedHeaders.join(" ");
        const signatureHeader = [
          `keyId="${keyId}"`,
          `algorithm="${profile.algorithm}"`,
          `headers="${signedHeadersList}"`,
          `signature="${signature}"`,
        ].join(",");

        // Build output headers
        const outHeaders = {
          Date: date,
          Signature: signatureHeader,
        };
        if (digest) {
          outHeaders.Digest = digest;
        }

        return {
          requestId,
          ok: true,
          actorUri,
          profile: profileName,
          signedComponents: {
            method,
            path,
            host,
          },
          outHeaders,
          meta: {
            keyId,
            algorithm: profile.algorithm,
            signedHeaders: signedHeadersList,
            bodySha256Base64,
          },
        };
      } catch (e) {
        return this._err(r, "INTERNAL_ERROR", e?.message || "signing failed", true);
      }
    },
  },
};
