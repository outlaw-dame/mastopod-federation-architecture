/**
 * Signing Client for ActivityPods Signing API
 *
 * Calls ActivityPods' `signing.signHttpRequestsBatch` REST endpoint to obtain
 * HTTP Signatures for outbound federation requests.  Private keys NEVER leave
 * ActivityPods — the sidecar supplies the request metadata and receives back
 * the ready-to-use signed headers.
 *
 * Wire contract (ActivityPods signing.service.js):
 *   POST /api/internal/signatures/batch
 *   Auth: Bearer <ACTIVITYPODS_TOKEN>
 *
 *   Request item shape:
 *     { requestId, actorUri, method, profile,
 *       target: { host, path, query },
 *       body?: { bytes, encoding },
 *       digest?: { mode: "server_compute" } }
 *
 *   Response item shape (success):
 *     { requestId, ok: true,
 *       outHeaders: { Date, Signature, Digest? },
 *       meta: { keyId, algorithm, signedHeaders, bodySha256Base64? } }
 *
 *   Response item shape (error):
 *     { requestId, ok: false,
 *       error: { code, message, retryable } }
 *
 * This client handles:
 *   - URL → structured target transformation
 *   - Profile selection (ap_get_v1 / ap_post_v1)
 *   - ActivityPods → public SignResult remapping
 *   - Exponential back-off with jitter on transient failures
 *   - Body-size pre-screening
 *   - Token-empty startup warning
 */

import { request } from "undici";
import { logger } from "../utils/logger.js";
import type {
  SignAtprotoCommitRequest,
  SignAtprotoCommitResponse,
  SignPlcOperationRequest,
  SignPlcOperationResponse,
  GetAtprotoPublicKeyRequest,
  GetAtprotoPublicKeyResponse,
} from "../core-domain/contracts/SigningContracts.js";

// ============================================================================
// Public types  (used by outbound-worker.ts and tests)
// ============================================================================

export type SignProfile = "ap_get_v1" | "ap_post_v1" | "ap_post_v1_ct";

export interface SignRequest {
  requestId: string;
  actorUri: string;
  method: "GET" | "POST";
  /** Full URL of the remote inbox, e.g. https://mastodon.social/inbox */
  targetUrl: string;
  /**
   * Raw serialised body that will be transmitted unchanged.
   * Required for POST; must be the exact bytes that will be sent so the
   * digest computed by ActivityPods matches what the remote server receives.
   */
  body?: string;
}

export interface SignSuccessResult {
  requestId: string;
  ok: true;
  signedHeaders: {
    /** IMF-fixdate value to use as the HTTP `Date` header */
    date: string;
    /** `SHA-256=<base64>` value to use as the HTTP `Digest` header (POST only) */
    digest?: string;
    /** Full Cavage `Signature` header value */
    signature: string;
  };
  meta?: {
    keyId: string;
    algorithm: string;
    /** Space-separated list of signed header names */
    signedHeaders: string;
  };
}

export interface SignErrorResult {
  requestId: string;
  ok: false;
  error: {
    code: SigningErrorCode;
    message: string;
    /** Authoritative retryability flag propagated from ActivityPods */
    retryable: boolean;
  };
}

export type SignResult = SignSuccessResult | SignErrorResult;

export type SigningErrorCode =
  | "ACTOR_NOT_LOCAL"   // Actor not owned by this ActivityPods instance
  | "ACTOR_NOT_FOUND"   // Actor deleted or never existed
  | "KEY_NOT_FOUND"     // No signing key material available for actor
  | "AUTH_FAILED"       // Sidecar token rejected by ActivityPods
  | "INVALID_REQUEST"   // Malformed signing request
  | "BODY_TOO_LARGE"    // Activity body exceeds configured limit
  | "RATE_LIMITED"      // ActivityPods asked us to back off
  | "INTERNAL_ERROR";   // Transient server-side failure

// ============================================================================
// Internal wire-format types  (ActivityPods signing.service.js contract)
// ============================================================================

/** One item in the POST /api/internal/signatures/batch request body */
interface ApSigningItem {
  requestId: string;
  actorUri: string;
  method: string;
  /** "ap_get_v1" | "ap_post_v1" | "ap_post_v1_ct" */
  profile: string;
  target: {
    /** hostname[:port] — no scheme, no path */
    host: string;
    /** URL path, must start with "/" */
    path: string;
    /** URL query string including "?", or "" */
    query?: string;
  };
  /** Present only for POST */
  body?: {
    bytes: string;
    encoding: "utf8";
  };
  /** Present only for POST */
  digest?: {
    mode: "server_compute";
  };
}

interface ApSignSuccessResult {
  requestId: string;
  ok: true;
  outHeaders: {
    /** IMF-fixdate */
    Date: string;
    /** Full Cavage Signature header value */
    Signature: string;
    /** `SHA-256=<base64>` — present only when digest was computed */
    Digest?: string;
  };
  meta?: {
    keyId: string;
    algorithm: string;
    signedHeaders: string;
    bodySha256Base64?: string;
  };
}

interface ApSignErrorResult {
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

type ApSignResult = ApSignSuccessResult | ApSignErrorResult;

interface ApSignBatchResponse {
  results: ApSignResult[];
}

// ============================================================================
// Config
// ============================================================================

export interface SigningClientConfig {
  /** Base URL of the ActivityPods instance, e.g. http://activitypods:3000 */
  baseUrl: string;
  /** Bearer token for /api/internal/signatures/batch (ACTIVITYPODS_TOKEN) */
  token: string;
  /** Maximum items per HTTP call to the signing API */
  maxBatchSize: number;
  /** Pre-screen body size (bytes) before sending to ActivityPods */
  maxBodyBytes: number;
  /** Per-attempt HTTP timeout in milliseconds */
  timeoutMs: number;
  /** Number of total attempts (1 = no retry) */
  maxRetries: number;
  /** Base back-off delay in milliseconds — doubles each attempt */
  retryDelayMs: number;
}

// ============================================================================
// SigningClient
// ============================================================================

export class SigningClient {
  private readonly config: SigningClientConfig;

  constructor(config: SigningClientConfig) {
    this.config = config;

    if (!config.token) {
      logger.warn(
        "SigningClient: ACTIVITYPODS_TOKEN is not set — " +
        "every signing request will be rejected with AUTH_FAILED"
      );
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Sign a batch of outbound HTTP requests.
   * Splits into chunks of `maxBatchSize` and fans out.
   */
  async signBatch(requests: SignRequest[]): Promise<SignResult[]> {
    if (requests.length === 0) return [];

    const all: SignResult[] = [];
    for (let i = 0; i < requests.length; i += this.config.maxBatchSize) {
      const chunk = requests.slice(i, i + this.config.maxBatchSize);
      const results = await this._signChunk(chunk);
      all.push(...results);
    }
    return all;
  }

  /**
   * Convenience wrapper for a single request.
   */
  async signOne(req: Omit<SignRequest, "requestId">): Promise<SignResult> {
    const requestId = `sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const results = await this.signBatch([{ ...req, requestId }]);
    return results[0];
  }

  /**
   * Returns true when the error represents a permanent failure that should
   * NOT be retried (move to DLQ immediately).  Uses the server-authoritative
   * `retryable` flag propagated from ActivityPods' signing service.
   */
  static isPermanentError(result: SignErrorResult): boolean {
    return !result.error.retryable;
  }

  // --------------------------------------------------------------------------
  // ATProto signing methods (V6.5 extensions)
  // --------------------------------------------------------------------------

  /**
   * Sign an ATProto repository commit.
   * Calls POST /api/internal/atproto/commit-sign on the signing service.
   * The private secp256k1 signing key never leaves ActivityPods.
   */
  async signAtprotoCommit(
    req: SignAtprotoCommitRequest
  ): Promise<SignAtprotoCommitResponse> {
    return this._callAtprotoEndpoint<SignAtprotoCommitResponse>(
      "POST",
      "/api/internal/atproto/commit-sign",
      req
    );
  }

  /**
   * Sign a did:plc operation using the account's rotation key.
   * Calls POST /api/internal/atproto/plc-sign on the signing service.
   */
  async signAtprotoPlcOp(
    req: SignPlcOperationRequest
  ): Promise<SignPlcOperationResponse> {
    return this._callAtprotoEndpoint<SignPlcOperationResponse>(
      "POST",
      "/api/internal/atproto/plc-sign",
      req
    );
  }

  /**
   * Retrieve the ATProto public key for an account (commit or rotation key).
   * Calls GET /api/internal/atproto/public-key on the signing service.
   * Returns multibase-encoded secp256k1 compressed public key.
   */
  async getAtprotoPublicKey(
    req: GetAtprotoPublicKeyRequest
  ): Promise<GetAtprotoPublicKeyResponse> {
    // GET with query params
    const qs = `?canonicalAccountId=${encodeURIComponent(req.canonicalAccountId)}&purpose=${encodeURIComponent(req.purpose)}`;
    return this._callAtprotoEndpoint<GetAtprotoPublicKeyResponse>(
      "GET",
      `/api/internal/atproto/public-key${qs}`,
      null
    );
  }

  /**
   * Shared HTTP helper for the ATProto signing endpoints.
   * These are synchronous per-request (not batched), with the same auth,
   * timeout, and retry policy as the AP batch endpoint.
   */
  private async _callAtprotoEndpoint<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const base = this.config.retryDelayMs * Math.pow(2, attempt - 1);
        const jitter = base * (Math.random() * 0.2 - 0.1);
        await this._sleep(Math.min(base + jitter, 30_000));
      }

      try {
        const opts: Parameters<typeof request>[1] = {
          method,
          headers: {
            authorization: `Bearer ${this.config.token}`,
            ...(body !== null ? { "content-type": "application/json" } : {}),
          },
          bodyTimeout: this.config.timeoutMs,
          headersTimeout: this.config.timeoutMs,
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
        };

        const res = await request(url, opts);

        if (res.statusCode === 401 || res.statusCode === 403) {
          await res.body.text();
          throw new Error(`ATProto signing API: auth failed (${res.statusCode}) — ${path}`);
        }

        if (res.statusCode === 429) {
          const retryAfter = parseInt((res.headers["retry-after"] as string) || "5", 10);
          await res.body.text();
          await this._sleep(retryAfter * 1_000);
          continue;
        }

        if (res.statusCode >= 500) {
          const errBody = await res.body.text();
          logger.warn("ATProto signing API: server error", { status: res.statusCode, path, errBody, attempt });
          continue;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const errBody = await res.body.text();
          throw new Error(`ATProto signing API: HTTP ${res.statusCode} — ${errBody}`);
        }

        return (await res.body.json()) as T;

      } catch (err: any) {
        lastErr = err;
        const isTransient =
          err.code === "ECONNREFUSED" ||
          err.code === "ETIMEDOUT" ||
          err.code === "UND_ERR_CONNECT_TIMEOUT" ||
          err.code === "UND_ERR_SOCKET" ||
          err.name === "AbortError";
        if (isTransient) {
          logger.warn("ATProto signing API: network error", { error: err.message, path, attempt });
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `ATProto signing API unavailable after ${this.config.maxRetries} attempts — ${path}: ${lastErr?.message}`
    );
  }

  // --------------------------------------------------------------------------
  // Internal implementation
  // --------------------------------------------------------------------------

  private async _signChunk(requests: SignRequest[]): Promise<SignResult[]> {
    // --- Phase 1: transform + pre-screen each request ---
    const apItems: ApSigningItem[] = [];
    const earlyErrors: SignResult[] = [];

    for (const req of requests) {
      const transformed = this._toApItem(req);
      if ("_earlyError" in transformed) {
        earlyErrors.push(transformed._earlyError);
        continue;
      }
      if (req.body !== undefined && req.body.length > this.config.maxBodyBytes) {
        earlyErrors.push({
          requestId: req.requestId,
          ok: false,
          error: {
            code: "BODY_TOO_LARGE",
            message: `Body ${req.body.length}B exceeds limit ${this.config.maxBodyBytes}B`,
            retryable: false,
          },
        });
        continue;
      }
      apItems.push(transformed);
    }

    if (apItems.length === 0) return earlyErrors;

    // --- Phase 2: call ActivityPods with exponential back-off + jitter ---
    const url = `${this.config.baseUrl}/api/internal/signatures/batch`;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential back-off: base * 2^(attempt-1), capped at 30 s, ±10 % jitter
        const base = this.config.retryDelayMs * Math.pow(2, attempt - 1);
        const jitter = base * (Math.random() * 0.2 - 0.1); // -10 % … +10 %
        await this._sleep(Math.min(base + jitter, 30_000));
      }

      try {
        const res = await request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.token}`,
          },
          body: JSON.stringify({ requests: apItems }),
          bodyTimeout: this.config.timeoutMs,
          headersTimeout: this.config.timeoutMs,
        });

        // --- Auth failures — permanent, do not retry ---
        if (res.statusCode === 401 || res.statusCode === 403) {
          const body = await res.body.text();
          logger.error("Signing API: authentication failure", {
            status: res.statusCode,
            body,
          });
          return [
            ...earlyErrors,
            ...apItems.map((r) => this._authFailedResult(r.requestId)),
          ];
        }

        // --- Rate-limited — wait Retry-After then retry ---
        if (res.statusCode === 429) {
          const retryAfter = parseInt(
            (res.headers["retry-after"] as string) || "5",
            10
          );
          logger.warn("Signing API: rate limited", { retryAfter, attempt });
          await res.body.text(); // consume to free connection
          await this._sleep(retryAfter * 1_000);
          continue;
        }

        // --- Server errors (5xx) — transient, back-off and retry ---
        if (res.statusCode >= 500) {
          const body = await res.body.text();
          logger.warn("Signing API: server error", {
            status: res.statusCode,
            body,
            attempt,
          });
          continue;
        }

        // --- Other non-2xx client errors — permanent ---
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const body = await res.body.text();
          logger.error("Signing API: unexpected client error", {
            status: res.statusCode,
            body,
          });
          return [
            ...earlyErrors,
            ...apItems.map((r) => ({
              requestId: r.requestId,
              ok: false as const,
              error: {
                code: "INVALID_REQUEST" as SigningErrorCode,
                message: `Signing API returned HTTP ${res.statusCode}`,
                retryable: false,
              },
            })),
          ];
        }

        // --- Success: parse + remap ---
        const parsed = (await res.body.json()) as ApSignBatchResponse;
        if (!Array.isArray(parsed?.results)) {
          logger.error("Signing API: malformed response (missing results array)", {
            parsed,
          });
          // Treat as transient — the service may be mid-deploy
          continue;
        }

        const remapped = parsed.results.map((r) => this._fromApResult(r));
        logger.debug("Signing API: batch complete", {
          total: apItems.length,
          ok: remapped.filter((r) => r.ok).length,
          errors: remapped.filter((r) => !r.ok).length,
        });

        return [...earlyErrors, ...remapped];

      } catch (err: any) {
        lastErr = err;

        const isTransient =
          err.code === "ECONNREFUSED" ||
          err.code === "ENOTFOUND" ||
          err.code === "ETIMEDOUT" ||
          err.code === "UND_ERR_CONNECT_TIMEOUT" ||
          err.code === "UND_ERR_SOCKET" ||
          err.name === "AbortError" ||
          (typeof err.message === "string" && err.message.includes("timeout"));

        if (isTransient) {
          logger.warn("Signing API: network error", {
            error: err.message,
            code: err.code,
            attempt,
          });
          continue;
        }

        // Unexpected error — escalate immediately
        throw err;
      }
    }

    // All retries exhausted
    logger.error("Signing API: unavailable after retries", {
      attempts: this.config.maxRetries,
      error: lastErr?.message,
    });
    return [
      ...earlyErrors,
      ...apItems.map((r) => ({
        requestId: r.requestId,
        ok: false as const,
        error: {
          code: "INTERNAL_ERROR" as SigningErrorCode,
          message: lastErr?.message ?? "Signing API unavailable",
          retryable: true,
        },
      })),
    ];
  }

  // --------------------------------------------------------------------------
  // Request transformation  (public SignRequest → ActivityPods wire format)
  // --------------------------------------------------------------------------

  /**
   * Transforms one `SignRequest` into an `ApSigningItem`.
   * Returns `{ _earlyError: SignErrorResult }` on validation failure so the
   * caller can collect it without throwing.
   */
  private _toApItem(
    req: SignRequest
  ): ApSigningItem | { _earlyError: SignErrorResult } {
    const fail = (msg: string): { _earlyError: SignErrorResult } => ({
      _earlyError: {
        requestId: req.requestId,
        ok: false,
        error: { code: "INVALID_REQUEST", message: msg, retryable: false },
      },
    });

    // actorUri — must be a non-empty string (validated as URL by ActivityPods)
    if (!req.actorUri || typeof req.actorUri !== "string") {
      return fail("actorUri is required");
    }

    // targetUrl — must parse as http(s) URL
    let parsed: URL;
    try {
      parsed = new URL(req.targetUrl);
    } catch {
      return fail(`targetUrl is not a valid URL: ${req.targetUrl}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return fail(`targetUrl has unsupported protocol: ${parsed.protocol}`);
    }

    const method = req.method.toUpperCase() as "GET" | "POST";
    const isPost = method === "POST";

    // Select signing profile based on HTTP method
    const profile: SignProfile = isPost ? "ap_post_v1" : "ap_get_v1";

    const item: ApSigningItem = {
      requestId: req.requestId,
      actorUri: req.actorUri,
      method,
      profile,
      target: {
        // parsed.host includes port when non-standard (e.g. "mastodon.social:8443")
        host: parsed.host,
        path: parsed.pathname,
        query: parsed.search || "",
      },
    };

    if (isPost && req.body !== undefined) {
      item.body = { bytes: req.body, encoding: "utf8" };
      item.digest = { mode: "server_compute" };
    }

    return item;
  }

  // --------------------------------------------------------------------------
  // Response remapping  (ActivityPods wire format → public SignResult)
  // --------------------------------------------------------------------------

  private _fromApResult(ap: ApSignResult): SignResult {
    if (!ap.ok) {
      const e = (ap as ApSignErrorResult).error;
      return {
        requestId: ap.requestId,
        ok: false,
        error: {
          code: this._mapErrorCode(e?.code),
          message: e?.message ?? "Signing failed",
          // Authoritative retryability from the signing service
          retryable: e?.retryable ?? false,
        },
      };
    }

    const success = ap as ApSignSuccessResult;
    const out = success.outHeaders;

    // Guard: ActivityPods should never return ok=true without Signature+Date
    if (!out?.Signature || !out?.Date) {
      logger.error(
        "Signing API returned ok=true but missing Signature or Date",
        { requestId: ap.requestId, outHeaders: out }
      );
      return {
        requestId: ap.requestId,
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "ok=true response is missing Signature or Date header",
          retryable: true,
        },
      };
    }

    const result: SignSuccessResult = {
      requestId: ap.requestId,
      ok: true,
      // Normalise to lowercase field names expected by outbound-worker.ts
      signedHeaders: {
        date: out.Date,
        signature: out.Signature,
        ...(out.Digest ? { digest: out.Digest } : {}),
      },
    };

    if (success.meta) {
      result.meta = {
        keyId: success.meta.keyId,
        algorithm: success.meta.algorithm,
        signedHeaders: success.meta.signedHeaders,
      };
    }

    return result;
  }

  /**
   * Map ActivityPods error codes to our public `SigningErrorCode` enum.
   * Unknown codes fall back to INTERNAL_ERROR (safest default).
   */
  private _mapErrorCode(apCode: string | undefined): SigningErrorCode {
    const map: Record<string, SigningErrorCode> = {
      ACTOR_NOT_LOCAL:     "ACTOR_NOT_LOCAL",
      ACTOR_NOT_FOUND:     "ACTOR_NOT_FOUND",
      KEY_UNAVAILABLE:     "KEY_NOT_FOUND",
      INVALID_INPUT:       "INVALID_REQUEST",
      PROFILE_NOT_ALLOWED: "INVALID_REQUEST",
      PROFILE_INVALID:     "INVALID_REQUEST",
      DIGEST_MISMATCH:     "INVALID_REQUEST",
      BODY_TOO_LARGE:      "BODY_TOO_LARGE",
      AUTH_FAILED:         "AUTH_FAILED",
      RATE_LIMITED:        "RATE_LIMITED",
      INTERNAL_ERROR:      "INTERNAL_ERROR",
    };
    return map[apCode ?? ""] ?? "INTERNAL_ERROR";
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private _authFailedResult(requestId: string): SignErrorResult {
    return {
      requestId,
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: "ActivityPods rejected the bearer token",
        retryable: false,
      },
    };
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createSigningClient(
  overrides?: Partial<SigningClientConfig>
): SigningClient {
  const config: SigningClientConfig = {
    baseUrl:      process.env.ACTIVITYPODS_URL   ?? "http://localhost:3000",
    token:        process.env.ACTIVITYPODS_TOKEN  ?? "",
    maxBatchSize: 200,
    maxBodyBytes: 512 * 1024,   // 512 KB — matches ActivityPods default
    timeoutMs:    30_000,
    maxRetries:   4,            // 1 initial + 3 retries → back-off: 1 s, 2 s, 4 s
    retryDelayMs: 1_000,
    ...overrides,
  };

  return new SigningClient(config);
}
