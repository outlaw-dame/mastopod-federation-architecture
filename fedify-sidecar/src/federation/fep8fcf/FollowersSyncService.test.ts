import { describe, expect, it, vi } from "vitest";
import { FollowersSyncService } from "./FollowersSyncService.js";

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
});
