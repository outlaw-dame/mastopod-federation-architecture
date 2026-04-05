import { resolveTxt as defaultResolveTxt } from "node:dns/promises";
import type { AtIdentityResolver } from "./AtIngressVerifier.js";
import { AtIngressHttpClient, AtIngressHttpError } from "./AtIngressHttpClient.js";
import { isValidDid, isValidHandle } from "../identity/HandleResolutionReader.js";

export interface HttpAtIdentityResolverOptions {
  fetchImpl?: typeof fetch;
  resolveTxtImpl?: typeof defaultResolveTxt;
  timeoutMs?: number;
  maxAttempts?: number;
  maxJsonBytes?: number;
  didDocumentCacheTtlMs?: number;
  didDocumentCacheMaxEntries?: number;
  failedResolutionCacheTtlMs?: number;
}

export interface ResolvedAtIdentityDocument {
  did: string;
  didDocument: Record<string, unknown>;
  handle: string | null;
  pdsEndpoint: string | null;
}

export class HttpAtIdentityResolver implements AtIdentityResolver {
  private readonly httpClient: AtIngressHttpClient;
  private readonly resolveTxtImpl: typeof defaultResolveTxt;
  private readonly maxJsonBytes: number;
  private readonly didDocumentCacheTtlMs: number;
  private readonly didDocumentCacheMaxEntries: number;
  private readonly didDocumentCache = new Map<string, {
    resolved: ResolvedAtIdentityDocument;
    expiresAt: number;
  }>();
  private readonly failedResolutionCacheTtlMs: number;
  private readonly failedResolutionCache = new Map<string, {
    reason: string;
    expiresAt: number;
  }>();
  private readonly inFlightResolutions = new Map<string, Promise<ResolvedAtIdentityDocument>>();

  private _fetchAttempts = 0;
  private _positiveCacheHits = 0;
  private _negativeCacheHits = 0;
  private _inFlightDedup = 0;

  public constructor(options: HttpAtIdentityResolverOptions = {}) {
    this.httpClient = new AtIngressHttpClient({
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
    });
    this.resolveTxtImpl = options.resolveTxtImpl ?? defaultResolveTxt;
    this.maxJsonBytes = clampInteger(options.maxJsonBytes ?? 256_000, 8_192, 2_000_000);
    this.didDocumentCacheTtlMs = clampInteger(options.didDocumentCacheTtlMs ?? 30_000, 0, 15 * 60_000);
    this.didDocumentCacheMaxEntries = clampInteger(options.didDocumentCacheMaxEntries ?? 2_000, 1, 50_000);
    this.failedResolutionCacheTtlMs = clampInteger(options.failedResolutionCacheTtlMs ?? 15_000, 0, 5 * 60_000);
  }

  public getMetrics(): {
    fetchAttempts: number;
    positiveCacheHits: number;
    negativeCacheHits: number;
    inFlightDedup: number;
  } {
    return {
      fetchAttempts: this._fetchAttempts,
      positiveCacheHits: this._positiveCacheHits,
      negativeCacheHits: this._negativeCacheHits,
      inFlightDedup: this._inFlightDedup,
    };
  }

  public async resolveIdentity(did: string): Promise<{
    success: boolean;
    handle?: string;
    didDocument?: Record<string, unknown>;
    reason?: string;
  }> {
    try {
      const resolved = await this.resolveDocument(did);
      return {
        success: true,
        handle: resolved.handle ?? undefined,
        didDocument: resolved.didDocument,
      };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async resolveDocument(did: string): Promise<ResolvedAtIdentityDocument> {
    if (!isValidDid(did)) {
      throw new Error(`Unsupported or invalid DID: ${did}`);
    }

    const now = Date.now();
    const cached = this.didDocumentCache.get(did);
    if (cached && cached.expiresAt > now) {
      this._positiveCacheHits += 1;
      return cached.resolved;
    }
    if (cached) {
      this.didDocumentCache.delete(did);
    }

    if (this.failedResolutionCacheTtlMs > 0) {
      const failedCached = this.failedResolutionCache.get(did);
      if (failedCached && failedCached.expiresAt > now) {
        this._negativeCacheHits += 1;
        throw new Error(failedCached.reason);
      }
      if (failedCached) {
        this.failedResolutionCache.delete(did);
      }
    }

      const inflight = this.inFlightResolutions.get(did);
      if (inflight) {
        this._inFlightDedup += 1;
        return inflight;
      }

      const promise = this.resolveDocumentInner(did).finally(() => {
        this.inFlightResolutions.delete(did);
      });
      this.inFlightResolutions.set(did, promise);
      return promise;
    }

    private async resolveDocumentInner(did: string): Promise<ResolvedAtIdentityDocument> {
      this._fetchAttempts += 1;
      const didDocumentUrl = buildDidResolutionUrl(did);
    let didDocument: Record<string, unknown>;
    try {
      didDocument = await this.httpClient.requestJson(didDocumentUrl, {
        accept: "application/json, application/did+ld+json, application/did+json",
        maxBytes: this.maxJsonBytes,
      });
    } catch (error) {
      if (this.failedResolutionCacheTtlMs > 0) {
        this.failedResolutionCache.set(did, {
          reason: error instanceof Error ? error.message : String(error),
          expiresAt: Date.now() + this.failedResolutionCacheTtlMs,
        });
      }
      throw error;
    }

    if (didDocument["id"] !== did) {
      throw new Error(`Resolved DID document did not match ${did}`);
    }

    const handle = await this.resolvePrimaryHandle(didDocument, did);
    const pdsEndpoint = extractPdsEndpoint(didDocument);

    const resolved = {
      did,
      didDocument,
      handle,
      pdsEndpoint,
    };

    this.cacheDidDocument(did, resolved);
    return resolved;
  }

  private async resolvePrimaryHandle(
    didDocument: Record<string, unknown>,
    did: string,
  ): Promise<string | null> {
    const handle = extractPrimaryHandle(didDocument);
    if (!handle) {
      return null;
    }

    try {
      const resolvedDid = await this.resolveHandle(handle);
      return resolvedDid === did ? handle : "handle.invalid";
    } catch {
      return "handle.invalid";
    }
  }

  private async resolveHandle(handle: string): Promise<string | null> {
    if (!isValidHandle(handle) || handle === "handle.invalid") {
      return null;
    }

    const dnsDid = await this.resolveHandleViaDns(handle);
    if (dnsDid) {
      return dnsDid;
    }

    const wellKnownUrl = buildHandleWellKnownUrl(handle);
    try {
      const body = await this.httpClient.requestText(wellKnownUrl, {
        accept: "text/plain",
        maxBytes: 4_096,
      });
      const candidate = body.trim();
      return isValidDid(candidate) ? candidate : null;
    } catch (error) {
      if (error instanceof AtIngressHttpError && !error.retryable) {
        return null;
      }
      return null;
    }
  }

  private async resolveHandleViaDns(handle: string): Promise<string | null> {
    try {
      const records = await this.resolveTxtImpl(`_atproto.${handle}`);
      for (const record of records) {
        const joined = record.join("");
        const did = extractDidFromTxtRecord(joined);
        if (did) {
          return did;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private cacheDidDocument(did: string, resolved: ResolvedAtIdentityDocument): void {
    if (this.didDocumentCacheTtlMs <= 0) {
      return;
    }

    while (this.didDocumentCache.size >= this.didDocumentCacheMaxEntries) {
      const oldestKey = this.didDocumentCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.didDocumentCache.delete(oldestKey);
    }

    this.didDocumentCache.set(did, {
      resolved,
      expiresAt: Date.now() + this.didDocumentCacheTtlMs,
    });
  }
}

function buildDidResolutionUrl(did: string): string {
  if (did.startsWith("did:plc:")) {
    return `https://plc.directory/${encodeURIComponent(did)}`;
  }

  if (!did.startsWith("did:web:")) {
    throw new Error(`Unsupported DID method for ${did}`);
  }

  const target = parseDidWebTarget(did);
  const protocol = target.hostname === "localhost" ? "http:" : "https:";
  const url = new URL(`${protocol}//${target.authority}`);

  if (target.pathSegments.length === 0) {
    url.pathname = "/.well-known/did.json";
  } else {
    url.pathname = `/${target.pathSegments.map((segment) => encodeURIComponent(segment)).join("/")}/did.json`;
  }

  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildHandleWellKnownUrl(handle: string): string {
  const protocol = handle === "localhost" || handle.startsWith("localhost:")
    ? "http:"
    : "https:";
  return new URL("/.well-known/atproto-did", `${protocol}//${handle}`).toString();
}

function parseDidWebTarget(did: string): {
  hostname: string;
  authority: string;
  pathSegments: string[];
} {
  const encodedIdentifier = did.slice("did:web:".length);
  const encodedParts = encodedIdentifier.split(":");
  const encodedAuthority = encodedParts[0] ?? "";
  const encodedPathSegments = encodedParts.slice(1);
  const authority = decodeURIComponent(encodedAuthority);
  const pathSegments = encodedPathSegments.map((segment) => decodeURIComponent(segment));

  if (!authority || authority.includes("/") || authority.includes("?") || authority.includes("#")) {
    throw new Error(`Unsupported did:web identifier: ${did}`);
  }

  if (pathSegments.some((segment) => !segment || segment.includes("/") || segment.includes("?") || segment.includes("#"))) {
    throw new Error(`Unsupported did:web path segments: ${did}`);
  }

  const probe = authority.includes(":")
    ? new URL(`http://${authority}`)
    : new URL(`https://${authority}`);

  if (probe.username || probe.password) {
    throw new Error(`did:web authority must not contain credentials: ${did}`);
  }

  if (probe.hostname !== "localhost" && probe.protocol !== "https:") {
    throw new Error(`did:web authority must resolve to HTTPS: ${did}`);
  }

  if (probe.pathname !== "/" || probe.search || probe.hash) {
    throw new Error(`did:web authority must not contain a path or query: ${did}`);
  }

  if (probe.hostname !== "localhost" && probe.port) {
    throw new Error(`did:web ports are only supported for localhost: ${did}`);
  }

  return {
    hostname: probe.hostname,
    authority: probe.port ? `${probe.hostname}:${probe.port}` : probe.hostname,
    pathSegments,
  };
}

function extractPrimaryHandle(didDocument: Record<string, unknown>): string | null {
  const aliases = didDocument["alsoKnownAs"];
  if (!Array.isArray(aliases)) {
    return null;
  }

  for (const alias of aliases) {
    if (typeof alias !== "string" || !alias.startsWith("at://")) {
      continue;
    }

    const candidate = alias.slice("at://".length).trim().toLowerCase();
    if (candidate && isValidHandle(candidate)) {
      return candidate;
    }
  }

  return null;
}

function extractPdsEndpoint(didDocument: Record<string, unknown>): string | null {
  const services = didDocument["service"];
  if (!Array.isArray(services)) {
    return null;
  }

  for (const service of services) {
    if (!service || typeof service !== "object" || Array.isArray(service)) {
      continue;
    }

    const record = service as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"] : "";
    const type = typeof record["type"] === "string" ? record["type"] : "";
    if (!id.endsWith("#atproto_pds") || type !== "AtprotoPersonalDataServer") {
      continue;
    }

    const endpoint = typeof record["serviceEndpoint"] === "string"
      ? normalizePdsEndpoint(record["serviceEndpoint"])
      : null;
    if (endpoint) {
      return endpoint;
    }
  }

  return null;
}

function normalizePdsEndpoint(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  const localhostHttp = parsed.protocol === "http:" && parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !localhostHttp) {
    return null;
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return null;
  }

  return parsed.origin;
}

function extractDidFromTxtRecord(record: string): string | null {
  const trimmed = record.trim().replace(/^"+|"+$/g, "");
  const directMatch = trimmed.match(/(?:^|;)did=(did:[a-z]+:[A-Za-z0-9._:-]+)(?:;|$)/);
  if (directMatch?.[1] && isValidDid(directMatch[1])) {
    return directMatch[1];
  }

  const legacyMatch = trimmed.match(/(?:^|;)v=atproto;t=did;v=(did:[a-z]+:[A-Za-z0-9._:-]+)(?:;|$)/);
  if (legacyMatch?.[1] && isValidDid(legacyMatch[1])) {
    return legacyMatch[1];
  }

  return null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
