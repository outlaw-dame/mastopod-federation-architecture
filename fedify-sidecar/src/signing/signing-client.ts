/**
 * Signing Client for ActivityPods Signing API
 *
 * Calls ActivityPods' `signing.signHttpRequestsBatch` REST endpoint to obtain
 * HTTP Signatures for outbound federation requests. Private keys for
 * ActivityPods-owned pod/user actors NEVER leave ActivityPods. When Fedify
 * runtime integration is enabled, `createSigningClient()` additionally routes
 * the exact configured sidecar relay/service actor through the sidecar-local
 * signer for `signOne` remote-fetch requests. No cross-authority fallback is
 * permitted.
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

import { Redis } from "ioredis";
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
import { ActorAuthoritySigningRouter } from "./ActorAuthoritySigningRouter.js";
import { SidecarLocalSigningService } from "./SidecarLocalSigningService.js";

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
  | "ACTOR_NOT_LOCAL"
  | "ACTOR_NOT_FOUND"
  | "KEY_NOT_FOUND"
  | "AUTH_FAILED"
  | "INVALID_REQUEST"
  | "BODY_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

interface ApSigningItem {
  requestId: string;
  actorUri: string;
  method: string;
  profile: string;
  target: {
    host: string;
    path: string;
    query?: string;
  };
  body?: {
    bytes: string;
    encoding: "utf8";
  };
  digest?: {
    mode: "server_compute";
  };
}

interface ApSignSuccessResult {
  requestId: string;
  ok: true;
  outHeaders: {
    Date: string;
    Signature: string;
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

export interface SigningClientConfig {
  baseUrl: string;
  token: string;
  maxBatchSize: number;
  maxBodyBytes: number;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

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

  async signOne(req: Omit<SignRequest, "requestId">): Promise<SignResult> {
    const requestId = `sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const results = await this.signBatch([{ ...req, requestId }]);
    const first = results[0];
    if (!first) {
      throw new Error("SigningClient: signBatch returned no results for signOne");
    }
    return first;
  }

  static isPermanentError(result: SignErrorResult): boolean {
    return !result.error.retryable;
  }

  async signAtprotoCommit(
    req: SignAtprotoCommitRequest
  ): Promise<SignAtprotoCommitResponse> {
    return this._callAtprotoEndpoint<SignAtprotoCommitResponse>(
      "POST",
      "/api/internal/atproto/commit-sign",
      req
    );
  }

  async signAtprotoPlcOp(
    req: SignPlcOperationRequest
  ): Promise<SignPlcOperationResponse> {
    return this._callAtprotoEndpoint<SignPlcOperationResponse>(
      "POST",
      "/api/internal/atproto/plc-sign",
      req
    );
  }

  async getAtprotoPublicKey(
    req: GetAtprotoPublicKeyRequest
  ): Promise<GetAtprotoPublicKeyResponse> {
    const qs = `?canonicalAccountId=${encodeURIComponent(req.canonicalAccountId)}&purpose=${encodeURIComponent(req.purpose)}`;
    return this._callAtprotoEndpoint<GetAtprotoPublicKeyResponse>(
      "GET",
      `/api/internal/atproto/public-key${qs}`,
      null
    );
  }

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
      `ATProto signing API unavailable after ${this.config.maxRetries} attempts — ${path}: ${this._getErrorMessage(lastErr, "Unknown error")}`
    );
  }

  private async _signChunk(requests: SignRequest[]): Promise<SignResult[]> {
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

    const url = `${this.config.baseUrl}/api/internal/signatures/batch`;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const base = this.config.retryDelayMs * Math.pow(2, attempt - 1);
        const jitter = base * (Math.random() * 0.2 - 0.1);
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

        if (res.statusCode === 429) {
          const retryAfter = parseInt(
            (res.headers["retry-after"] as string) || "5",
            10
          );
          logger.warn("Signing API: rate limited", { retryAfter, attempt });
          await res.body.text();
          await this._sleep(retryAfter * 1_000);
          continue;
        }

        if (res.statusCode >= 500) {
          const body = await res.body.text();
          logger.warn("Signing API: server error", {
            status: res.statusCode,
            body,
            attempt,
          });
          continue;
        }

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

        const parsed = (await res.body.json()) as ApSignBatchResponse;
        if (!Array.isArray(parsed?.results)) {
          logger.error("Signing API: malformed response (missing results array)", {
            parsed,
          });
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

        throw err;
      }
    }

    const lastErrMessage = this._getErrorMessage(lastErr, "Signing API unavailable");
    logger.error("Signing API: unavailable after retries", {
      attempts: this.config.maxRetries,
      error: lastErrMessage,
    });
    return [
      ...earlyErrors,
      ...apItems.map((r) => ({
        requestId: r.requestId,
        ok: false as const,
        error: {
          code: "INTERNAL_ERROR" as SigningErrorCode,
          message: lastErrMessage,
          retryable: true,
        },
      })),
    ];
  }

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

    if (!req.actorUri || typeof req.actorUri !== "string") {
      return fail("actorUri is required");
    }

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
    const profile: SignProfile = isPost ? "ap_post_v1" : "ap_get_v1";

    const item: ApSigningItem = {
      requestId: req.requestId,
      actorUri: req.actorUri,
      method,
      profile,
      target: {
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

  private _fromApResult(ap: ApSignResult): SignResult {
    if (!ap.ok) {
      const e = (ap as ApSignErrorResult).error;
      return {
        requestId: ap.requestId,
        ok: false,
        error: {
          code: this._mapErrorCode(e?.code),
          message: e?.message ?? "Signing failed",
          retryable: e?.retryable ?? false,
        },
      };
    }

    const success = ap as ApSignSuccessResult;
    const out = success.outHeaders;

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

  private _getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return fallback;
  }
}

export function resolveSidecarRelayActorUri(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const domain = env["DOMAIN"]?.trim() || "localhost";
  const expectedActorUri = `https://${domain}/users/relay`;
  const configuredActorUri = env["AP_RELAY_LOCAL_ACTOR_URI"]?.trim();

  if (configuredActorUri && configuredActorUri !== expectedActorUri) {
    throw new Error(
      `AP_RELAY_LOCAL_ACTOR_URI must exactly match the Fedify-served relay actor URI: ${expectedActorUri}`,
    );
  }

  return expectedActorUri;
}

export function createSigningClient(
  overrides?: Partial<SigningClientConfig>
): SigningClient {
  const config: SigningClientConfig = {
    baseUrl:      process.env["ACTIVITYPODS_URL"]   ?? "http://localhost:3000",
    token:        process.env["ACTIVITYPODS_TOKEN"]  ?? "",
    maxBatchSize: 200,
    maxBodyBytes: 512 * 1024,
    timeoutMs:    30_000,
    maxRetries:   4,
    retryDelayMs: 1_000,
    ...overrides,
  };

  const client = new SigningClient(config);

  if (process.env["ENABLE_FEDIFY_RUNTIME_INTEGRATION"] === "true") {
    const relayActorUri = resolveSidecarRelayActorUri();
    const localSigningRedis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
    localSigningRedis.on("error", (err: Error) =>
      logger.error("Authority-aware signing Redis error", { error: err.message }),
    );
    const localSigningService = new SidecarLocalSigningService(localSigningRedis);
    const activityPodsSignOne = client.signOne.bind(client);
    const router = new ActorAuthoritySigningRouter(
      { signOne: activityPodsSignOne },
      localSigningService,
      {
        sidecarServiceActors: [{ actorUri: relayActorUri, identifier: "relay" }],
        sidecarPublicDomain: process.env["DOMAIN"]?.trim() || "localhost",
      },
    );

    client.signOne = router.signOne.bind(router);
    logger.info("SigningClient: authority-aware signOne routing enabled", {
      sidecarServiceActor: relayActorUri,
    });
  }

  return client;
}
