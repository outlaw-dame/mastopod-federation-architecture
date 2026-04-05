import type { AtSyncRebuilder } from "./AtIngressVerifier.js";
import {
  RegistryError,
  RegistryErrorCode,
  type AtprotoRepoRegistry,
} from "../../atproto/repo/AtprotoRepoRegistry.js";
import type { RepositoryState } from "../../atproto/repo/AtprotoRepoState.js";
import { HttpAtIdentityResolver } from "./HttpAtIdentityResolver.js";
import { AtIngressHttpClient } from "./AtIngressHttpClient.js";
import { isValidDid } from "../identity/HandleResolutionReader.js";

export interface HttpAtSyncRebuilderOptions {
  repoRegistry: AtprotoRepoRegistry;
  identityResolver: HttpAtIdentityResolver;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  maxRepoBytes?: number;
  maxJsonBytes?: number;
  didFailureCacheTtlMs?: number;
  originFailureCacheTtlMs?: number;
}

interface SyncRebuildFailureCacheEntry {
  reason: string;
  expiresAt: number;
}

interface SyncRebuildResult {
  success: boolean;
  reason?: string;
}

export class HttpAtSyncRebuilder implements AtSyncRebuilder {
  private readonly repoRegistry: AtprotoRepoRegistry;
  private readonly identityResolver: HttpAtIdentityResolver;
  private readonly httpClient: AtIngressHttpClient;
  private readonly maxRepoBytes: number;
  private readonly maxJsonBytes: number;
  private readonly didFailureCacheTtlMs: number;
  private readonly originFailureCacheTtlMs: number;
  private readonly didFailureCache = new Map<string, SyncRebuildFailureCacheEntry>();
  private readonly originFailureCache = new Map<string, SyncRebuildFailureCacheEntry>();
  private readonly inFlightRebuilds = new Map<string, Promise<SyncRebuildResult>>();

  public constructor(options: HttpAtSyncRebuilderOptions) {
    this.repoRegistry = options.repoRegistry;
    this.identityResolver = options.identityResolver;
    this.httpClient = new AtIngressHttpClient({
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
    });
    this.maxRepoBytes = clampInteger(options.maxRepoBytes ?? 32 * 1024 * 1024, 1_048_576, 256 * 1024 * 1024);
    this.maxJsonBytes = clampInteger(options.maxJsonBytes ?? 64_000, 8_192, 1_000_000);
    this.didFailureCacheTtlMs = clampInteger(options.didFailureCacheTtlMs ?? 60_000, 0, 10 * 60_000);
    this.originFailureCacheTtlMs = clampInteger(options.originFailureCacheTtlMs ?? 30_000, 0, 10 * 60_000);
  }

  public async rebuildRepo(
    did: string,
    options: { source?: string | null } = {},
  ): Promise<SyncRebuildResult> {
    if (!isValidDid(did)) {
      return { success: false, reason: `Unsupported or invalid DID: ${did}` };
    }

    const now = Date.now();
    const cachedFailure = this.didFailureCache.get(did);
    if (cachedFailure && cachedFailure.expiresAt > now) {
      return { success: false, reason: cachedFailure.reason };
    }
    if (cachedFailure) {
      this.didFailureCache.delete(did);
    }

    const inFlight = this.inFlightRebuilds.get(did);
    if (inFlight) {
      return inFlight;
    }

    const rebuildPromise = this.rebuildRepoInner(did, options).finally(() => {
      this.inFlightRebuilds.delete(did);
    });
    this.inFlightRebuilds.set(did, rebuildPromise);
    return rebuildPromise;
  }

  private async rebuildRepoInner(
    did: string,
    options: { source?: string | null },
  ): Promise<SyncRebuildResult> {
    try {
      const identity = await this.identityResolver.resolveDocument(did);
      if (!identity.pdsEndpoint) {
        return {
          success: false,
          reason: `DID document for ${did} did not contain a valid AtprotoPersonalDataServer endpoint`,
        };
      }

      const candidateOrigins = buildRepoOrigins(options.source, identity.pdsEndpoint);
      const repoBytes = await this.fetchRepoCar(candidateOrigins, did);
      const latestCommit = await this.fetchLatestCommit(identity.pdsEndpoint, did);
      const rootCid = await readCarRootCid(repoBytes);

      if (rootCid !== latestCommit.cid) {
        return {
          success: false,
          reason: `Repo CAR root ${rootCid} did not match latest commit ${latestCommit.cid}`,
        };
      }

      const existing = typeof this.repoRegistry.getRepoState === "function"
        ? await this.repoRegistry.getRepoState(did)
        : await this.repoRegistry.getByDid(did);

      const nextState = buildRebuiltRepoState(existing, {
        did,
        rootCid,
        rev: latestCommit.rev,
      });

      await this.persistRepoState(did, nextState, existing);
      this.didFailureCache.delete(did);
      return { success: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.didFailureCacheTtlMs > 0 && isTransientSyncFailure(error)) {
        this.didFailureCache.set(did, {
          reason,
          expiresAt: Date.now() + this.didFailureCacheTtlMs,
        });
      }
      return { success: false, reason };
    }
  }

  private async fetchRepoCar(origins: string[], did: string): Promise<Uint8Array> {
    let lastError: Error | null = null;
    for (const origin of origins) {
      const originFailure = this.getOriginFailure(origin);
      if (originFailure) {
        lastError = new Error(originFailure.reason);
        continue;
      }

      try {
        const url = new URL("/xrpc/com.atproto.sync.getRepo", origin);
        url.searchParams.set("did", did);
        return await this.httpClient.requestBytes(url.toString(), {
          accept: "application/vnd.ipld.car",
          maxBytes: this.maxRepoBytes,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.maybeCacheOriginFailure(origin, error, "repo export fetch failed");
      }
    }

    throw lastError ?? new Error(`Unable to fetch repo export for ${did}`);
  }

  private async fetchLatestCommit(origin: string, did: string): Promise<{ cid: string; rev: string }> {
    const originFailure = this.getOriginFailure(origin);
    if (originFailure) {
      throw new Error(originFailure.reason);
    }

    const url = new URL("/xrpc/com.atproto.sync.getLatestCommit", origin);
    url.searchParams.set("did", did);

    let payload: Record<string, unknown>;
    try {
      payload = await this.httpClient.requestJson(url.toString(), {
        accept: "application/json",
        maxBytes: this.maxJsonBytes,
      });
    } catch (error) {
      this.maybeCacheOriginFailure(origin, error, "latest commit fetch failed");
      throw error;
    }

    const cid = typeof payload["cid"] === "string" ? payload["cid"] : null;
    const rev = typeof payload["rev"] === "string" ? payload["rev"] : null;
    if (!cid || !rev) {
      throw new Error(`Latest commit response for ${did} was missing cid or rev`);
    }

    return { cid, rev };
  }

  private async persistRepoState(
    did: string,
    nextState: RepositoryState,
    existing: RepositoryState | null,
  ): Promise<void> {
    try {
      if (existing) {
        await this.repoRegistry.update(nextState);
      } else {
        await this.repoRegistry.register(nextState);
      }
      return;
    } catch (error) {
      if (!isRecoverableRegistryRace(error)) {
        throw error;
      }
    }

    const latestExisting = typeof this.repoRegistry.getRepoState === "function"
      ? await this.repoRegistry.getRepoState(did)
      : await this.repoRegistry.getByDid(did);

    const recoveredState = buildRebuiltRepoState(latestExisting, {
      did,
      rootCid: nextState.rootCid ?? "",
      rev: nextState.rev,
    });

    if (latestExisting) {
      await this.repoRegistry.update(recoveredState);
    } else {
      await this.repoRegistry.register(recoveredState);
    }
  }

  private getOriginFailure(origin: string): SyncRebuildFailureCacheEntry | null {
    if (this.originFailureCacheTtlMs <= 0) {
      return null;
    }

    const cached = this.originFailureCache.get(origin);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.originFailureCache.delete(origin);
      return null;
    }

    return cached;
  }

  private maybeCacheOriginFailure(origin: string, error: unknown, prefix: string): void {
    if (this.originFailureCacheTtlMs <= 0 || !isTransientSyncFailure(error)) {
      return;
    }

    const cause = error instanceof Error ? error.message : String(error);
    this.originFailureCache.set(origin, {
      reason: `${prefix}; cooling down ${origin}: ${cause}`,
      expiresAt: Date.now() + this.originFailureCacheTtlMs,
    });
  }
}

function buildRepoOrigins(source: string | null | undefined, pdsEndpoint: string): string[] {
  const candidates: string[] = [];
  const sourceOrigin = normalizeSourceOrigin(source);
  if (sourceOrigin) {
    candidates.push(sourceOrigin);
  }
  if (!candidates.includes(pdsEndpoint)) {
    candidates.push(pdsEndpoint);
  }
  return candidates;
}

function normalizeSourceOrigin(source: string | null | undefined): string | null {
  if (!source) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return null;
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";

  const localhostHttp = parsed.protocol === "http:" && parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !localhostHttp) {
    return null;
  }

  return parsed.origin;
}

async function readCarRootCid(bytes: Uint8Array): Promise<string> {
  const { CarReader } = await import("@ipld/car");
  const reader = await CarReader.fromBytes(bytes);
  const roots = await reader.getRoots();
  const root = roots[0];
  if (!root) {
    throw new Error("Repo CAR export did not include a root CID");
  }
  return root.toString();
}

function buildRebuiltRepoState(
  existing: RepositoryState | null,
  input: { did: string; rootCid: string; rev: string },
): RepositoryState {
  const now = new Date().toISOString();

  if (!existing) {
    return {
      did: input.did,
      rootCid: input.rootCid,
      rev: input.rev,
      commits: [
        {
          cid: input.rootCid,
          rootCid: input.rootCid,
          rev: input.rev,
          timestamp: now,
          signature: "",
        },
      ],
      collections: [],
      totalRecords: 0,
      sizeBytes: 0,
      status: "active",
      lastCommitAt: now,
      snapshotAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    ...existing,
    rootCid: input.rootCid,
    rev: input.rev,
    status: "active",
    lastCommitAt: now,
    snapshotAt: now,
    updatedAt: now,
    commits: [
      {
        cid: input.rootCid,
        rootCid: input.rootCid,
        rev: input.rev,
        timestamp: now,
        signature: "",
      },
      ...existing.commits.filter((commit) => commit.rev !== input.rev).slice(0, 99),
    ],
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isTransientSyncFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (
    message.includes("network error")
    || message.includes("timed out")
    || message.includes("timeout")
  ) {
    return true;
  }

  if (error instanceof Error && "retryable" in error) {
    const retryable = (error as { retryable?: unknown }).retryable;
    return retryable === true;
  }

  return false;
}

function isRecoverableRegistryRace(error: unknown): boolean {
  return error instanceof RegistryError && (
    error.code === RegistryErrorCode.ALREADY_EXISTS
    || error.code === RegistryErrorCode.NOT_FOUND
  );
}
