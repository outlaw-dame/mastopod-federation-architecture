import { describe, expect, it, vi } from "vitest";
import { request } from "undici";
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