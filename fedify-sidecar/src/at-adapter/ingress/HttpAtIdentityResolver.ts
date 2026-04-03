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

  public constructor(options: HttpAtIdentityResolverOptions = {}) {
    this.httpClient = new AtIngressHttpClient({
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
    });
    this.resolveTxtImpl = options.resolveTxtImpl ?? defaultResolveTxt;
    this.maxJsonBytes = clampInteger(options.maxJsonBytes ?? 256_000, 8_192, 2_000_000);
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

    const didDocumentUrl = buildDidResolutionUrl(did);
    const didDocument = await this.httpClient.requestJson(didDocumentUrl, {
      accept: "application/json, application/did+ld+json, application/did+json",
      maxBytes: this.maxJsonBytes,
    });

    if (didDocument["id"] !== did) {
      throw new Error(`Resolved DID document did not match ${did}`);
    }

    const handle = await this.resolvePrimaryHandle(didDocument, did);
    const pdsEndpoint = extractPdsEndpoint(didDocument);

    return {
      did,
      didDocument,
      handle,
      pdsEndpoint,
    };
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
}

function buildDidResolutionUrl(did: string): string {
  if (did.startsWith("did:plc:")) {
    return `https://plc.directory/${encodeURIComponent(did)}`;
  }

  if (!did.startsWith("did:web:")) {
    throw new Error(`Unsupported DID method for ${did}`);
  }

  const authority = parseDidWebAuthority(did);
  const protocol = authority.hostname === "localhost" ? "http:" : "https:";
  return new URL("/.well-known/did.json", `${protocol}//${authority.authority}`).toString();
}

function buildHandleWellKnownUrl(handle: string): string {
  const protocol = handle === "localhost" || handle.startsWith("localhost:")
    ? "http:"
    : "https:";
  return new URL("/.well-known/atproto-did", `${protocol}//${handle}`).toString();
}

function parseDidWebAuthority(did: string): { hostname: string; authority: string } {
  const encodedAuthority = did.slice("did:web:".length);
  const authority = decodeURIComponent(encodedAuthority);

  if (!authority || authority.includes("/") || authority.includes("?") || authority.includes("#")) {
    throw new Error(`Unsupported did:web identifier: ${did}`);
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
