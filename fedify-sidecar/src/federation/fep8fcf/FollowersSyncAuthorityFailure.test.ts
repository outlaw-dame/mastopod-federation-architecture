import { describe, expect, it, vi } from "vitest";
import { FollowersSyncService } from "./FollowersSyncService.js";
import { FollowersSyncAuthorityError } from "./FollowersSyncActivityPodsClient.js";

function service() {
  return new FollowersSyncService({
    domain: "pods.example",
    activityPodsUrl: "https://activitypods.example",
    activityPodsToken: "test-token",
  });
}

function unavailable(): FollowersSyncAuthorityError {
  return new FollowersSyncAuthorityError("authority unavailable", {
    code: "authority_unavailable",
    statusCode: 503,
  });
}

describe("FollowersSyncService ActivityPods authority failures", () => {
  it("skips sender synchronization instead of advertising an empty digest", async () => {
    const instance = service();
    const getPartialFollowers = vi.fn().mockRejectedValue(unavailable());
    (instance as any).apClient = { getPartialFollowers };

    await expect(instance.buildSenderHeader(
      "alice",
      "https://pods.example/users/alice/followers",
      "https://remote.example/inbox",
    )).resolves.toBeNull();

    expect(getPartialFollowers).toHaveBeenCalledWith("alice", "https://remote.example");
  });

  it("propagates authority failure to the public synchronization route boundary", async () => {
    const instance = service();
    const error = unavailable();
    (instance as any).apClient = {
      getPartialFollowers: vi.fn().mockRejectedValue(error),
    };

    await expect(instance.getPartialFollowersCollection("alice", "https://remote.example"))
      .rejects.toBe(error);
  });

  it("still preserves a real empty authoritative collection", async () => {
    const instance = service();
    (instance as any).apClient = {
      getPartialFollowers: vi.fn().mockResolvedValue([]),
    };

    await expect(instance.getPartialFollowersCollection("alice", "https://remote.example"))
      .resolves.toEqual([]);
  });
});
