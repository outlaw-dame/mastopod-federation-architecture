import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAtprotoRepoRegistry,
  RegistryError,
  RegistryErrorCode,
  type AtprotoRepoRegistry,
} from "../../atproto/repo/AtprotoRepoRegistry.js";
import { HttpAtIdentityResolver } from "../ingress/HttpAtIdentityResolver.js";
import { HttpAtSyncRebuilder } from "../ingress/HttpAtSyncRebuilder.js";

describe("HttpAtSyncRebuilder", () => {
  it("prefers the direct upstream source for repo fetch, validates the CAR root, and updates repo state", async () => {
    const repoCid = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const repoBytes = await buildCarWithRoot(repoCid);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://plc.directory/did%3Aplc%3Aalice") {
        return jsonResponse({
          id: "did:plc:alice",
          alsoKnownAs: ["at://alice.example.com"],
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example.com",
            },
          ],
        });
      }
      if (url === "https://relay.example/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice") {
        return bytesResponse(repoBytes, "application/vnd.ipld.car");
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getLatestCommit?did=did%3Aplc%3Aalice") {
        return jsonResponse({
          cid: repoCid,
          rev: "3krev",
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const identityResolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl: vi.fn().mockResolvedValue([["did=did:plc:alice"]]),
    });
    const repoRegistry = new InMemoryAtprotoRepoRegistry();
    const rebuilder = new HttpAtSyncRebuilder({
      repoRegistry,
      identityResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await rebuilder.rebuildRepo("did:plc:alice", {
      source: "wss://relay.example/xrpc/com.atproto.sync.subscribeRepos",
    });

    expect(result).toEqual({ success: true });
    const state = await repoRegistry.getRepoState("did:plc:alice");
    expect(state).toEqual(
      expect.objectContaining({
        did: "did:plc:alice",
        rootCid: repoCid,
        rev: "3krev",
        status: "active",
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://relay.example/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice",
      expect.any(Object),
    );
  });

  it("falls back to the authoritative PDS when the direct upstream repo fetch fails", async () => {
    const repoCid = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const repoBytes = await buildCarWithRoot(repoCid);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://plc.directory/did%3Aplc%3Aalice") {
        return jsonResponse({
          id: "did:plc:alice",
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example.com",
            },
          ],
        });
      }
      if (url === "https://relay.example/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice") {
        return new Response("upstream unavailable", { status: 503 });
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice") {
        return bytesResponse(repoBytes, "application/vnd.ipld.car");
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getLatestCommit?did=did%3Aplc%3Aalice") {
        return jsonResponse({
          cid: repoCid,
          rev: "3krev",
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const identityResolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl: vi.fn().mockResolvedValue([]),
    });
    const repoRegistry = new InMemoryAtprotoRepoRegistry();
    const rebuilder = new HttpAtSyncRebuilder({
      repoRegistry,
      identityResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
    });

    const result = await rebuilder.rebuildRepo("did:plc:alice", {
      source: "wss://relay.example/xrpc/com.atproto.sync.subscribeRepos",
    });

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice",
      expect.any(Object),
    );
  });

  it("reuses transient DID rebuild failures within cooldown TTL", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://plc.directory/did%3Aplc%3Aalice") {
        return jsonResponse({
          id: "did:plc:alice",
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example.com",
            },
          ],
        });
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice") {
        throw new TypeError("fetch failed");
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const identityResolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl: vi.fn().mockResolvedValue([]),
      maxAttempts: 1,
    });

    const rebuilder = new HttpAtSyncRebuilder({
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
      identityResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
      didFailureCacheTtlMs: 60_000,
    });

    const first = await rebuilder.rebuildRepo("did:plc:alice");
    const second = await rebuilder.rebuildRepo("did:plc:alice");

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(second.reason).toContain("Network error while requesting");
  });

  it("deduplicates concurrent rebuilds for the same DID", async () => {
    const repoCid = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const repoBytes = await buildCarWithRoot(repoCid);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://plc.directory/did%3Aplc%3Aalice") {
        return jsonResponse({
          id: "did:plc:alice",
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example.com",
            },
          ],
        });
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return bytesResponse(repoBytes, "application/vnd.ipld.car");
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getLatestCommit?did=did%3Aplc%3Aalice") {
        return jsonResponse({
          cid: repoCid,
          rev: "3krev",
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const identityResolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl: vi.fn().mockResolvedValue([]),
      maxAttempts: 1,
    });
    const rebuilder = new HttpAtSyncRebuilder({
      repoRegistry: new InMemoryAtprotoRepoRegistry(),
      identityResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
    });

    const [first, second] = await Promise.all([
      rebuilder.rebuildRepo("did:plc:alice"),
      rebuilder.rebuildRepo("did:plc:alice"),
    ]);

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    const repoFetches = fetchImpl.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice"));
    expect(repoFetches).toHaveLength(1);
  });

  it("recovers cleanly when a concurrent rebuild wins the initial register race", async () => {
    const repoCid = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const repoBytes = await buildCarWithRoot(repoCid);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://plc.directory/did%3Aplc%3Aalice") {
        return jsonResponse({
          id: "did:plc:alice",
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example.com",
            },
          ],
        });
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getRepo?did=did%3Aplc%3Aalice") {
        return bytesResponse(repoBytes, "application/vnd.ipld.car");
      }
      if (url === "https://pds.example.com/xrpc/com.atproto.sync.getLatestCommit?did=did%3Aplc%3Aalice") {
        return jsonResponse({
          cid: repoCid,
          rev: "3krev",
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const identityResolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl: vi.fn().mockResolvedValue([]),
    });

    let storedState: any = null;
    let getCalls = 0;
    const repoRegistry: AtprotoRepoRegistry = {
      register: vi.fn(async (state) => {
        storedState = state;
        throw new RegistryError(
          RegistryErrorCode.ALREADY_EXISTS,
          `Repository already exists: ${state.did}`,
        );
      }),
      getByDid: vi.fn(async () => null),
      getRepoState: vi.fn(async () => {
        getCalls += 1;
        return getCalls === 1 ? null : storedState;
      }),
      update: vi.fn(async (state) => {
        storedState = state;
      }),
      delete: vi.fn(async () => false),
      list: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      exists: vi.fn(async () => false),
      getByCollection: vi.fn(async () => []),
      getWithPendingCommits: vi.fn(async () => []),
      transaction: vi.fn(async (callback) => callback(repoRegistry)),
      health: vi.fn(async () => true),
    };

    const rebuilder = new HttpAtSyncRebuilder({
      repoRegistry,
      identityResolver,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
    });

    const result = await rebuilder.rebuildRepo("did:plc:alice");

    expect(result).toEqual({ success: true });
    expect(repoRegistry.register).toHaveBeenCalledTimes(1);
    expect(repoRegistry.update).toHaveBeenCalledTimes(1);
  });
});

async function buildCarWithRoot(cidString: string): Promise<Uint8Array> {
  const [{ CarWriter }, { CID }] = await Promise.all([
    import("@ipld/car"),
    import("multiformats/cid"),
  ]);
  const { writer, out } = CarWriter.create([CID.parse(cidString)]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const chunk of out) {
      chunks.push(chunk);
    }
  })();
  await writer.close();
  await collect;

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function jsonResponse(body: Record<string, unknown>): Response {
  const encoded = JSON.stringify(body);
  return new Response(encoded, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(encoded, "utf8").toString(),
    },
  });
}

function bytesResponse(body: Uint8Array, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": body.byteLength.toString(),
    },
  });
}
