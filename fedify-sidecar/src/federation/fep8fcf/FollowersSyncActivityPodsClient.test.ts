import { describe, expect, it, vi } from "vitest";
import { request } from "undici";
import {
  FollowersSyncActivityPodsClient,
  FollowersSyncAuthorityError,
} from "./FollowersSyncActivityPodsClient.js";

vi.mock("undici", () => ({ request: vi.fn() }));
vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

const requestMock = vi.mocked(request);

function responseBody(chunks: Array<string | Buffer>) {
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

function client(overrides: Partial<ConstructorParameters<typeof FollowersSyncActivityPodsClient>[0]> = {}) {
  return new FollowersSyncActivityPodsClient({
    activityPodsUrl: "https://activitypods.example",
    activityPodsToken: "test-token",
    ...overrides,
  });
}

describe("FollowersSyncActivityPodsClient authority reads", () => {
  it("preserves a valid empty partial followers collection", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: responseBody([JSON.stringify({ followers: [] })]),
    } as any);

    await expect(client().getPartialFollowers("alice", "remote.example")).resolves.toEqual([]);
  });

  it("does not collapse an unavailable endpoint into authoritative empty state", async () => {
    const body = responseBody(["not used"]);
    requestMock.mockResolvedValueOnce({ statusCode: 501, body } as any);

    await expect(client().getPartialFollowers("alice", "remote.example")).rejects.toMatchObject({
      name: "FollowersSyncAuthorityError",
      code: "authority_unavailable",
      statusCode: 501,
    });
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized authority response before JSON materialization", async () => {
    const body = responseBody([
      Buffer.alloc(40_000, 0x20),
      Buffer.alloc(30_000, 0x20),
    ]);
    requestMock.mockResolvedValueOnce({ statusCode: 200, body } as any);

    await expect(client({ maxResponseBytes: 65_536 }).getPartialFollowers("alice", "remote.example"))
      .rejects.toMatchObject({ code: "response_too_large" });
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed partial follower entries instead of filtering them", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: responseBody([JSON.stringify({ followers: ["https://remote.example/users/bob", 42] })]),
    } as any);

    await expect(client().getPartialFollowers("alice", "remote.example"))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects partial collections above the configured complete-set ceiling", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: responseBody([JSON.stringify({
        followers: [
          "https://remote.example/users/a",
          "https://remote.example/users/b",
          "https://remote.example/users/c",
        ],
      })]),
    } as any);

    await expect(client({ maxCollectionItems: 2 }).getPartialFollowers("alice", "remote.example"))
      .rejects.toMatchObject({ code: "collection_too_large" });
  });

  it("validates every local follower record as complete authority data", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: responseBody([JSON.stringify({
        localActors: [
          { actorUri: "https://pods.example/users/alice", identifier: "alice" },
          { actorUri: "not-a-uri", identifier: "mallory" },
        ],
      })]),
    } as any);

    await expect(client().getLocalFollowersOfRemote("https://remote.example/users/bob"))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("returns a complete valid local follower set", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: responseBody([JSON.stringify({
        localActors: [
          { actorUri: "https://pods.example/users/alice", identifier: "alice" },
          { actorUri: "https://pods.example/users/charlie", identifier: "charlie" },
        ],
      })]),
    } as any);

    await expect(client().getLocalFollowersOfRemote("https://remote.example/users/bob"))
      .resolves.toEqual([
        { actorUri: "https://pods.example/users/alice", identifier: "alice" },
        { actorUri: "https://pods.example/users/charlie", identifier: "charlie" },
      ]);
  });

  it("fails startup configuration for an empty authority token", () => {
    expect(() => new FollowersSyncActivityPodsClient({
      activityPodsUrl: "https://activitypods.example",
      activityPodsToken: "",
    })).toThrow(/non-empty ActivityPods bearer token/u);
  });

  it("fails startup configuration for credential-bearing authority URLs", () => {
    expect(() => new FollowersSyncActivityPodsClient({
      activityPodsUrl: "https://user:pass@activitypods.example",
      activityPodsToken: "test-token",
    })).toThrow(/credential-free HTTP\(S\)/u);
  });

  it("exports typed authority failures for higher-level policy decisions", () => {
    const error = new FollowersSyncAuthorityError("unavailable", {
      code: "authority_unavailable",
      statusCode: 503,
    });
    expect(error).toMatchObject({
      name: "FollowersSyncAuthorityError",
      code: "authority_unavailable",
      statusCode: 503,
    });
  });
});
