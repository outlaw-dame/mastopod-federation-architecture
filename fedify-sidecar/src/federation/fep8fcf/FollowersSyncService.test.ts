import { describe, expect, it, vi } from "vitest";
import { request } from "undici";
import { parseCollectionSyncHeader } from "./CollectionSyncHeader.js";
import { FollowersSyncService } from "./FollowersSyncService.js";

vi.mock("undici", () => ({
  request: vi.fn(),
}));

const requestMock = vi.mocked(request);

function createResponseBody(chunks: Array<string | Buffer>) {
  const destroy = vi.fn();
  return {
    destroy,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      }
    },
  };
}

function signingClient() {
  return {
    signOne: vi.fn(async () => ({
      ok: true,
      signedHeaders: {
        date: "Sun, 16 Aug 2026 10:00:00 GMT",
        signature: "Signature test",
      },
    })),
  } as any;
}

function createSenderService(options: { redisCache?: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } } = {}) {
  const service = new FollowersSyncService({
    domain: "pods.example",
    activityPodsUrl: "https://activitypods.example",
    activityPodsToken: "test-token",
    ...(options.redisCache ? { redisCache: options.redisCache } : {}),
  });
  return service;
}

function injectPartialFollowersReader(
  service: FollowersSyncService,
  getPartialFollowers: ReturnType<typeof vi.fn>,
): void {
  (service as unknown as { apClient: { getPartialFollowers: typeof getPartialFollowers } }).apClient = {
    getPartialFollowers,
  };
}

describe("FollowersSyncService outbound digest single-flight", () => {
  it("shares only digest acquisition for concurrent same-actor same-origin headers", async () => {
    let release!: (followers: string[]) => void;
    const authorityRead = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const getPartialFollowers = vi.fn().mockReturnValue(authorityRead);
    const service = createSenderService();
    injectPartialFollowersReader(service, getPartialFollowers);

    const primaryCollection = "https://pods.example/users/alice/followers";
    const aliasCollection = "https://alias.example/users/alice/followers";
    const first = service.buildSenderHeader(
      "alice",
      primaryCollection,
      "https://remote.example/users/bob/inbox",
    );
    const second = service.buildSenderHeader(
      "alice",
      aliasCollection,
      "https://remote.example/shared/inbox",
    );

    expect(getPartialFollowers).toHaveBeenCalledTimes(1);
    expect(getPartialFollowers).toHaveBeenCalledWith("alice", "https://remote.example");

    release(["https://remote.example/users/follower"]);
    const [firstHeader, secondHeader] = await Promise.all([first, second]);
    const firstParams = parseCollectionSyncHeader(firstHeader!);
    const secondParams = parseCollectionSyncHeader(secondHeader!);

    expect(firstParams?.collectionId).toBe(primaryCollection);
    expect(secondParams?.collectionId).toBe(aliasCollection);
    expect(firstParams?.digest).toBe(secondParams?.digest);
  });

  it("does not share digest acquisition across target origins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getPartialFollowers = vi.fn(async () => {
      await gate;
      return [];
    });
    const service = createSenderService();
    injectPartialFollowersReader(service, getPartialFollowers);

    const first = service.buildSenderHeader(
      "alice",
      "https://pods.example/users/alice/followers",
      "https://one.example/inbox",
    );
    const second = service.buildSenderHeader(
      "alice",
      "https://pods.example/users/alice/followers",
      "https://two.example/inbox",
    );

    expect(getPartialFollowers).toHaveBeenCalledTimes(2);
    expect(getPartialFollowers).toHaveBeenCalledWith("alice", "https://one.example");
    expect(getPartialFollowers).toHaveBeenCalledWith("alice", "https://two.example");
    release();
    await Promise.all([first, second]);
  });

  it("does not share digest acquisition across local actors", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getPartialFollowers = vi.fn(async () => {
      await gate;
      return [];
    });
    const service = createSenderService();
    injectPartialFollowersReader(service, getPartialFollowers);

    const first = service.buildSenderHeader(
      "alice",
      "https://pods.example/users/alice/followers",
      "https://remote.example/inbox",
    );
    const second = service.buildSenderHeader(
      "bob",
      "https://pods.example/users/bob/followers",
      "https://remote.example/inbox",
    );

    expect(getPartialFollowers).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, second]);
  });

  it("releases a completed single-flight entry instead of becoming a second cache", async () => {
    const getPartialFollowers = vi.fn().mockResolvedValue([]);
    const service = createSenderService();
    injectPartialFollowersReader(service, getPartialFollowers);
    const input = [
      "alice",
      "https://pods.example/users/alice/followers",
      "https://remote.example/inbox",
    ] as const;

    await expect(service.buildSenderHeader(...input)).resolves.not.toBeNull();
    await expect(service.buildSenderHeader(...input)).resolves.not.toBeNull();
    expect(getPartialFollowers).toHaveBeenCalledTimes(2);
  });

  it("releases a failed single-flight entry so a later authority read can recover", async () => {
    const getPartialFollowers = vi.fn()
      .mockRejectedValueOnce(new Error("authority unavailable"))
      .mockResolvedValueOnce([]);
    const service = createSenderService();
    injectPartialFollowersReader(service, getPartialFollowers);
    const input = [
      "alice",
      "https://pods.example/users/alice/followers",
      "https://remote.example/inbox",
    ] as const;

    await expect(service.buildSenderHeader(...input)).resolves.toBeNull();
    await expect(service.buildSenderHeader(...input)).resolves.not.toBeNull();
    expect(getPartialFollowers).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent Redis cache lookups for the same digest scope", async () => {
    let releaseCache!: (value: string | null) => void;
    const cacheRead = new Promise<string | null>((resolve) => {
      releaseCache = resolve;
    });
    const redisCache = {
      get: vi.fn().mockReturnValue(cacheRead),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const getPartialFollowers = vi.fn().mockResolvedValue([]);
    const service = createSenderService({ redisCache });
    injectPartialFollowersReader(service, getPartialFollowers);

    const first = service.buildSenderHeader(
      "alice",
      "https://pods.example/users/alice/followers",
      "https://remote.example/inbox",
    );
    const second = service.buildSenderHeader(
      "alice",
      "https://pods.example/users/alice/followers",
      "https://remote.example/shared/inbox",
    );

    expect(redisCache.get).toHaveBeenCalledTimes(1);
    releaseCache(JSON.stringify({ digest: "cached-digest", computedAt: Date.now() }));
    const headers = await Promise.all([first, second]);

    expect(getPartialFollowers).not.toHaveBeenCalled();
    expect(redisCache.set).not.toHaveBeenCalled();
    for (const header of headers) {
      expect(parseCollectionSyncHeader(header!)?.digest).toBe("cached-digest");
    }
  });
});

describe("FollowersSyncService reconciliation", () => {
  it("removes stale local follows and invokes stale remote cleanup without failing reconciliation", async () => {
    const senderActorUri = "https://remote.example/users/bob";
    const staleCleanup = vi
      .fn<(localActorUri: string, remoteActorUri: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup failed"));
    const onStaleRemoteEntry = (localActorUri: string, remoteActorUri: string) =>
      staleCleanup(localActorUri, remoteActorUri);
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
      onStaleRemoteEntry,
    });
    const removeLocalFollow = vi.fn().mockResolvedValue(true);

    (service as unknown as { apClient: { removeLocalFollow: typeof removeLocalFollow } }).apClient = {
      removeLocalFollow,
    };

    await (service as unknown as {
      reconcile: (
        senderActorUri: string,
        localFollowers: Array<{ actorUri: string; identifier: string }>,
        remotePartialFollowers: string[],
      ) => Promise<void>;
    }).reconcile(
      senderActorUri,
      [{ actorUri: "https://pods.example/users/alice", identifier: "alice" }],
      [
        "https://pods.example/users/charlie",
        "https://pods.example/users/dana",
        "https://other.example/users/not-local",
      ],
    );

    expect(removeLocalFollow).toHaveBeenCalledWith("alice", senderActorUri);
    expect(staleCleanup).toHaveBeenCalledTimes(2);
    expect(staleCleanup).toHaveBeenNthCalledWith(1, "https://pods.example/users/charlie", senderActorUri);
    expect(staleCleanup).toHaveBeenNthCalledWith(2, "https://pods.example/users/dana", senderActorUri);
  });

  it("bounds concurrent stale remote cleanup callbacks", async () => {
    const senderActorUri = "https://remote.example/users/bob";
    let active = 0;
    let maxActive = 0;
    const staleCleanup = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    });
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
      staleCleanupConcurrency: 3,
      onStaleRemoteEntry: staleCleanup,
    });
    const removeLocalFollow = vi.fn().mockResolvedValue(true);
    (service as unknown as { apClient: { removeLocalFollow: typeof removeLocalFollow } }).apClient = {
      removeLocalFollow,
    };

    const remoteFollowers = Array.from(
      { length: 40 },
      (_, index) => `https://pods.example/users/unknown-${index}`,
    );
    await (service as any).reconcile(senderActorUri, [], remoteFollowers);

    expect(staleCleanup).toHaveBeenCalledTimes(40);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("deduplicates repeated stale remote entries before cleanup", async () => {
    const senderActorUri = "https://remote.example/users/bob";
    const staleCleanup = vi.fn().mockResolvedValue(undefined);
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
      onStaleRemoteEntry: staleCleanup,
    });
    (service as any).apClient = { removeLocalFollow: vi.fn().mockResolvedValue(true) };

    await (service as any).reconcile(senderActorUri, [], [
      "https://pods.example/users/charlie",
      "https://pods.example/users/charlie",
      "https://pods.example/users/charlie",
    ]);

    expect(staleCleanup).toHaveBeenCalledTimes(1);
    expect(staleCleanup).toHaveBeenCalledWith("https://pods.example/users/charlie", senderActorUri);
  });

  it("rejects a remote partial collection that exceeds the response byte limit without truncating it", async () => {
    const body = createResponseBody([
      Buffer.alloc(40_000, 0x20),
      Buffer.alloc(30_000, 0x20),
    ]);
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body,
    } as any);
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
      maxRemoteCollectionBytes: 65_536,
    });

    const result = await (service as any).fetchRemotePartialCollection(
      "https://remote.example/users/bob/followers_synchronization",
      "https://pods.example/users/alice",
      signingClient(),
    );

    expect(result).toBeNull();
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects a complete remote collection above the configured item ceiling", async () => {
    const payload = JSON.stringify({
      type: "OrderedCollection",
      orderedItems: [
        "https://pods.example/users/a",
        "https://pods.example/users/b",
        "https://pods.example/users/c",
      ],
    });
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: createResponseBody([payload]),
    } as any);
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
      maxRemoteCollectionItems: 2,
    });

    await expect((service as any).fetchRemotePartialCollection(
      "https://remote.example/users/bob/followers_synchronization",
      "https://pods.example/users/alice",
      signingClient(),
    )).resolves.toBeNull();
  });

  it("rejects overlong remote follower URIs rather than reconciling a partial list", async () => {
    const payload = JSON.stringify({
      type: "Collection",
      items: [`https://pods.example/users/${"x".repeat(300)}`],
    });
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: createResponseBody([payload]),
    } as any);
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
      maxRemoteFollowerUriBytes: 256,
    });

    await expect((service as any).fetchRemotePartialCollection(
      "https://remote.example/users/bob/followers_synchronization",
      "https://pods.example/users/alice",
      signingClient(),
    )).resolves.toBeNull();
  });

  it("rejects malformed follower entries rather than treating the collection as complete", async () => {
    const payload = JSON.stringify({
      type: "OrderedCollection",
      orderedItems: [
        "https://pods.example/users/a",
        { unexpected: "missing-id" },
      ],
    });
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: createResponseBody([payload]),
    } as any);
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
    });

    await expect((service as any).fetchRemotePartialCollection(
      "https://remote.example/users/bob/followers_synchronization",
      "https://pods.example/users/alice",
      signingClient(),
    )).resolves.toBeNull();
  });

  it("accepts a bounded complete remote partial collection", async () => {
    const payload = JSON.stringify({
      type: "OrderedCollection",
      orderedItems: [
        "https://pods.example/users/a",
        { id: "https://pods.example/users/b" },
      ],
    });
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: createResponseBody([payload]),
    } as any);
    const service = new FollowersSyncService({
      domain: "pods.example",
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "test-token",
      maxRemoteCollectionItems: 10,
    });

    await expect((service as any).fetchRemotePartialCollection(
      "https://remote.example/users/bob/followers_synchronization",
      "https://pods.example/users/alice",
      signingClient(),
    )).resolves.toEqual([
      "https://pods.example/users/a",
      "https://pods.example/users/b",
    ]);
  });
});
