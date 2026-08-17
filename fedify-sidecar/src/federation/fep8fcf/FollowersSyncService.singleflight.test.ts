import { describe, expect, it, vi } from "vitest";
import { parseCollectionSyncHeader } from "./CollectionSyncHeader.js";
import {
  FollowersSyncService,
  type FollowersSyncRedisCache,
} from "./FollowersSyncService.js";

function createSenderService(redisCache?: FollowersSyncRedisCache): FollowersSyncService {
  return new FollowersSyncService({
    domain: "pods.example",
    activityPodsUrl: "https://activitypods.example",
    activityPodsToken: "test-token",
    ...(redisCache ? { redisCache } : {}),
  });
}

function injectPartialFollowersReader(
  service: FollowersSyncService,
  getPartialFollowers: (actorIdentifier: string, targetOrigin: string) => Promise<string[]>,
): void {
  (service as unknown as {
    apClient: {
      getPartialFollowers: typeof getPartialFollowers;
    };
  }).apClient = { getPartialFollowers };
}

describe("FollowersSyncService outbound digest single-flight", () => {
  it("shares only digest acquisition for concurrent same-actor same-origin headers", async () => {
    let release!: (followers: string[]) => void;
    const authorityRead = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const getPartialFollowers = vi.fn(
      async (_actorIdentifier: string, _targetOrigin: string) => authorityRead,
    );
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
    const getPartialFollowers = vi.fn(async () => [] as string[]);
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
    const getPartialFollowers = vi.fn<
      (actorIdentifier: string, targetOrigin: string) => Promise<string[]>
    >();
    getPartialFollowers
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
    const redisGet = vi.fn(async (_key: string): Promise<string | null> => cacheRead);
    const redisSet = vi.fn(async (
      _key: string,
      _value: string,
      _exFlag: "EX",
      _ttlSeconds: number,
    ): Promise<unknown> => undefined);
    const redisCache: FollowersSyncRedisCache = {
      get: redisGet,
      set: redisSet,
    };
    const getPartialFollowers = vi.fn(async () => [] as string[]);
    const service = createSenderService(redisCache);
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

    expect(redisGet).toHaveBeenCalledTimes(1);
    releaseCache(JSON.stringify({ digest: "cached-digest", computedAt: Date.now() }));
    const headers = await Promise.all([first, second]);

    expect(getPartialFollowers).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    for (const header of headers) {
      expect(parseCollectionSyncHeader(header!)?.digest).toBe("cached-digest");
    }
  });
});
