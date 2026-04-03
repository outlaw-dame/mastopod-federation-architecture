import type { AtSyncRebuilder } from "./AtIngressVerifier.js";
import type { AtprotoRepoRegistry } from "../../atproto/repo/AtprotoRepoRegistry.js";
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
}

export class HttpAtSyncRebuilder implements AtSyncRebuilder {
  private readonly repoRegistry: AtprotoRepoRegistry;
  private readonly identityResolver: HttpAtIdentityResolver;
  private readonly httpClient: AtIngressHttpClient;
  private readonly maxRepoBytes: number;
  private readonly maxJsonBytes: number;

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
  }

  public async rebuildRepo(
    did: string,
    options: { source?: string | null } = {},
  ): Promise<{ success: boolean; reason?: string }> {
    try {
      if (!isValidDid(did)) {
        return { success: false, reason: `Unsupported or invalid DID: ${did}` };
      }

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

      if (existing) {
        await this.repoRegistry.update(nextState);
      } else {
        await this.repoRegistry.register(nextState);
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchRepoCar(origins: string[], did: string): Promise<Uint8Array> {
    let lastError: Error | null = null;
    for (const origin of origins) {
      try {
        const url = new URL("/xrpc/com.atproto.sync.getRepo", origin);
        url.searchParams.set("did", did);
        return await this.httpClient.requestBytes(url.toString(), {
          accept: "application/vnd.ipld.car",
          maxBytes: this.maxRepoBytes,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error(`Unable to fetch repo export for ${did}`);
  }

  private async fetchLatestCommit(origin: string, did: string): Promise<{ cid: string; rev: string }> {
    const url = new URL("/xrpc/com.atproto.sync.getLatestCommit", origin);
    url.searchParams.set("did", did);

    const payload = await this.httpClient.requestJson(url.toString(), {
      accept: "application/json",
      maxBytes: this.maxJsonBytes,
    });

    const cid = typeof payload["cid"] === "string" ? payload["cid"] : null;
    const rev = typeof payload["rev"] === "string" ? payload["rev"] : null;
    if (!cid || !rev) {
      throw new Error(`Latest commit response for ${did} was missing cid or rev`);
    }

    return { cid, rev };
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
