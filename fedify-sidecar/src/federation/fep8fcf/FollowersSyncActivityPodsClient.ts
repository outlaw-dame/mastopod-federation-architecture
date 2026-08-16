/**
 * FEP-8fcf: ActivityPods internal API client for followers synchronization.
 *
 * Calls the ActivityPods internal followers-sync authority endpoints. Read
 * failures are deliberately distinguishable from a valid empty collection:
 * callers must never treat an unavailable, malformed, or oversized authority
 * response as authoritative `[]` state.
 *
 * ActivityPods routes:
 *
 *   GET  /api/internal/followers-sync-v2/partial-collection
 *          ?actorIdentifier={id}&baseUri={serverBaseUri}
 *        → { followers: string[] }
 *
 *   GET  /api/internal/followers-sync/local-followers-of-remote
 *          ?remoteActorUri={encoded}
 *        → { localActors: Array<{ actorUri: string; identifier: string }> }
 *
 *   POST /api/internal/followers-sync/unfollow
 *        Body: { localActorIdentifier: string; remoteActorUri: string }
 *        → 200 OK
 */

import { request } from "undici";
import { logger } from "../../utils/logger.js";

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COLLECTION_ITEMS = 10_000;
const DEFAULT_MAX_URI_BYTES = 4096;
const DEFAULT_MAX_IDENTIFIER_BYTES = 512;

// ============================================================================
// Types
// ============================================================================

export interface FollowersSyncApClientConfig {
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxCollectionItems?: number;
  maxUriBytes?: number;
  maxIdentifierBytes?: number;
}

export interface LocalActorFollowerRecord {
  /** Full URI of the local actor, e.g. "https://our.example.com/users/alice" */
  actorUri: string;
  /** Local identifier used in API paths, e.g. "alice" */
  identifier: string;
}

type BoundedResponseBody = AsyncIterable<Uint8Array> & {
  destroy?: () => void;
};

export class FollowersSyncAuthorityError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(message: string, options: { code: string; statusCode?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FollowersSyncAuthorityError";
    this.code = options.code;
    this.statusCode = options.statusCode;
  }
}

// ============================================================================
// Client
// ============================================================================

export class FollowersSyncActivityPodsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxCollectionItems: number;
  private readonly maxUriBytes: number;
  private readonly maxIdentifierBytes: number;

  constructor(config: FollowersSyncApClientConfig) {
    const parsedBaseUrl = parseAuthorityBaseUrl(config.activityPodsUrl);
    const token = String(config.activityPodsToken ?? "").trim();
    if (!token) {
      throw new Error("Followers sync requires a non-empty ActivityPods bearer token");
    }

    this.baseUrl = parsedBaseUrl;
    this.token = token;
    this.timeoutMs = clampInteger(config.requestTimeoutMs, 10_000, 250, 120_000);
    this.maxResponseBytes = clampInteger(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      64 * 1024,
      32 * 1024 * 1024,
    );
    this.maxCollectionItems = clampInteger(
      config.maxCollectionItems,
      DEFAULT_MAX_COLLECTION_ITEMS,
      1,
      100_000,
    );
    this.maxUriBytes = clampInteger(config.maxUriBytes, DEFAULT_MAX_URI_BYTES, 256, 16 * 1024);
    this.maxIdentifierBytes = clampInteger(
      config.maxIdentifierBytes,
      DEFAULT_MAX_IDENTIFIER_BYTES,
      32,
      4096,
    );
  }

  // --------------------------------------------------------------------------
  // getPartialFollowers
  // --------------------------------------------------------------------------

  /**
   * Return the complete bounded follower set for one FEP-8fcf server base URI.
   * The base URI is scheme + authority (including an explicit port) + root '/'.
   *
   * A valid empty collection returns `[]`. Authority unavailability, malformed
   * data, or an oversized response throws FollowersSyncAuthorityError so the
   * optional FEP path can abort instead of reconciling against false empty state.
   */
  async getPartialFollowers(actorIdentifier: string, serverBaseUriValue: string): Promise<string[]> {
    const serverBaseUri = normalizeServerBaseUri(serverBaseUriValue);
    if (!serverBaseUri) {
      throw authorityError("FEP-8fcf server base URI is invalid", "invalid_server_base_uri");
    }

    const url =
      `${this.baseUrl}/api/internal/followers-sync-v2/partial-collection` +
      `?actorIdentifier=${encodeURIComponent(actorIdentifier)}` +
      `&baseUri=${encodeURIComponent(serverBaseUri)}`;

    try {
      const body = await this.getAuthorityJson(url, "getPartialFollowers");
      if (!Array.isArray(body["followers"])) {
        throw authorityError("ActivityPods partial followers response is missing followers[]", "invalid_response");
      }
      if (body["followers"].length > this.maxCollectionItems) {
        throw authorityError("ActivityPods partial followers response exceeds item limit", "collection_too_large");
      }

      return body["followers"].map((value) => {
        const uri = normalizeHttpUri(value, this.maxUriBytes);
        if (!uri) {
          throw authorityError("ActivityPods partial followers response contains an invalid follower URI", "invalid_response");
        }
        return uri;
      });
    } catch (err) {
      const normalized = normalizeAuthorityError(err, "getPartialFollowers");
      logger.warn("[fep8fcf] getPartialFollowers: authority read failed", {
        actorIdentifier,
        serverBaseUri,
        code: normalized.code,
        status: normalized.statusCode,
        error: normalized.message,
      });
      throw normalized;
    }
  }

  // --------------------------------------------------------------------------
  // getLocalFollowersOfRemote
  // --------------------------------------------------------------------------

  /**
   * Return the complete bounded set of local actors following a remote actor.
   * Valid empty state is `[]`; authority failure is an exception.
   */
  async getLocalFollowersOfRemote(remoteActorUri: string): Promise<LocalActorFollowerRecord[]> {
    const url =
      `${this.baseUrl}/api/internal/followers-sync/local-followers-of-remote` +
      `?remoteActorUri=${encodeURIComponent(remoteActorUri)}`;

    try {
      const body = await this.getAuthorityJson(url, "getLocalFollowersOfRemote");
      if (!Array.isArray(body["localActors"])) {
        throw authorityError("ActivityPods local followers response is missing localActors[]", "invalid_response");
      }
      if (body["localActors"].length > this.maxCollectionItems) {
        throw authorityError("ActivityPods local followers response exceeds item limit", "collection_too_large");
      }

      return body["localActors"].map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw authorityError("ActivityPods local followers response contains an invalid actor entry", "invalid_response");
        }
        const record = value as Record<string, unknown>;
        const actorUri = normalizeHttpUri(record["actorUri"], this.maxUriBytes);
        const identifier = normalizeIdentifier(record["identifier"], this.maxIdentifierBytes);
        if (!actorUri || !identifier) {
          throw authorityError("ActivityPods local followers response contains an invalid actor entry", "invalid_response");
        }
        return { actorUri, identifier };
      });
    } catch (err) {
      const normalized = normalizeAuthorityError(err, "getLocalFollowersOfRemote");
      logger.warn("[fep8fcf] getLocalFollowersOfRemote: authority read failed", {
        remoteActorUri,
        code: normalized.code,
        status: normalized.statusCode,
        error: normalized.message,
      });
      throw normalized;
    }
  }

  // --------------------------------------------------------------------------
  // removeLocalFollow
  // --------------------------------------------------------------------------

  /**
   * Remove a local actor's follow of a remote actor.
   *
   * This mutation remains best-effort for FEP reconciliation. Failure returns
   * false and never changes the caller's interpretation of authoritative read
   * state.
   */
  async removeLocalFollow(
    localActorIdentifier: string,
    remoteActorUri: string,
  ): Promise<boolean> {
    try {
      const resp = await request(
        `${this.baseUrl}/api/internal/followers-sync/unfollow`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ localActorIdentifier, remoteActorUri }),
          bodyTimeout: this.timeoutMs,
          headersTimeout: this.timeoutMs,
          maxRedirections: 0,
        },
      );

      const ok = resp.statusCode >= 200 && resp.statusCode < 300;
      resp.body.destroy();
      return ok;
    } catch (err: any) {
      logger.warn("[fep8fcf] removeLocalFollow: request error", {
        localActorIdentifier,
        remoteActorUri,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async getAuthorityJson(url: string, operation: string): Promise<Record<string, unknown>> {
    let resp;
    try {
      resp = await request(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
        maxRedirections: 0,
      });
    } catch (err) {
      throw authorityError(`ActivityPods ${operation} request failed`, "request_failed", undefined, err);
    }

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      resp.body.destroy();
      const code = resp.statusCode === 404 || resp.statusCode === 501
        ? "authority_unavailable"
        : "authority_http_error";
      throw authorityError(
        `ActivityPods ${operation} returned HTTP ${resp.statusCode}`,
        code,
        resp.statusCode,
      );
    }

    return readBoundedJsonObject(resp.body as unknown as BoundedResponseBody, this.maxResponseBytes);
  }
}

async function readBoundedJsonObject(
  body: BoundedResponseBody,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        body.destroy?.();
        throw authorityError("ActivityPods followers-sync response exceeds byte limit", "response_too_large");
      }
      chunks.push(buffer);
    }
  } catch (err) {
    if (err instanceof FollowersSyncAuthorityError) throw err;
    throw authorityError("ActivityPods followers-sync response stream failed", "response_read_failed", undefined, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
  } catch (err) {
    throw authorityError("ActivityPods followers-sync response is not valid JSON", "invalid_json", undefined, err);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw authorityError("ActivityPods followers-sync response must be a JSON object", "invalid_response");
  }
  return parsed as Record<string, unknown>;
}

function parseAuthorityBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("Followers sync requires a valid ActivityPods URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("Followers sync ActivityPods URL must be credential-free HTTP(S)");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeServerBaseUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function normalizeHttpUri(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeIdentifier(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxBytes) return null;
  return trimmed;
}

function authorityError(
  message: string,
  code: string,
  statusCode?: number,
  cause?: unknown,
): FollowersSyncAuthorityError {
  return new FollowersSyncAuthorityError(message, { code, statusCode, cause });
}

function normalizeAuthorityError(error: unknown, operation: string): FollowersSyncAuthorityError {
  if (error instanceof FollowersSyncAuthorityError) return error;
  return authorityError(
    `ActivityPods ${operation} failed`,
    "authority_error",
    undefined,
    error,
  );
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value as number)));
}
