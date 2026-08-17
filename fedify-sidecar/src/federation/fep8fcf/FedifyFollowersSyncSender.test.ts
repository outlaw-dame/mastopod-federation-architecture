import { describe, expect, it, vi } from "vitest";
import { FedifyFollowersSyncSender } from "./FedifyFollowersSyncSender.js";
import { isFollowersAddressedActivity } from "./FollowersSyncOutboundEligibility.js";

function activity(recipients: Record<string, unknown>, actor = "https://example.com/users/alice"): string {
  return JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://example.com/activities/1",
    type: "Create",
    actor,
    ...recipients,
    object: {
      id: "https://example.com/notes/1",
      type: "Note",
      content: "Hello",
    },
  });
}

describe("FEP-8fcf Fedify outbound sender", () => {
  it("recognizes followers addressing across ActivityPub recipient fields", () => {
    const followers = "https://example.com/users/alice/followers";
    expect(isFollowersAddressedActivity(activity({ to: followers }), "https://example.com/users/alice")).toBe(true);
    expect(isFollowersAddressedActivity(activity({ cc: [followers] }), "https://example.com/users/alice")).toBe(true);
    expect(isFollowersAddressedActivity(activity({ audience: followers }), "https://example.com/users/alice/")).toBe(true);
    expect(isFollowersAddressedActivity(activity({ to: "https://www.w3.org/ns/activitystreams#Public" }), "https://example.com/users/alice")).toBe(false);
  });

  it("fails closed to not eligible for malformed or oversized activity JSON", () => {
    expect(isFollowersAddressedActivity("{", "https://example.com/users/alice")).toBe(false);
    expect(isFollowersAddressedActivity("x".repeat(2 * 1024 * 1024 + 1), "https://example.com/users/alice")).toBe(false);
  });

  it("builds a header only for followers-addressed deliveries", async () => {
    const buildSenderHeader = vi.fn().mockResolvedValue("collectionId=\"x\", digest=\"y\", url=\"z\"");
    const sender = new FedifyFollowersSyncSender("example.com", { buildSenderHeader });

    const result = await sender.buildHeader({
      actorUri: "https://example.com/users/alice",
      activity: activity({ cc: ["https://example.com/users/alice/followers"] }),
      targetInbox: "https://remote.example/inbox",
    });

    expect(result).toContain("collectionId");
    expect(buildSenderHeader).toHaveBeenCalledWith(
      "alice",
      "https://example.com/users/alice/followers",
      "https://remote.example/inbox",
    );

    const publicOnly = await sender.buildHeader({
      actorUri: "https://example.com/users/alice",
      activity: activity({ to: "https://www.w3.org/ns/activitystreams#Public" }),
      targetInbox: "https://remote.example/inbox",
    });
    expect(publicOnly).toBeNull();
    expect(buildSenderHeader).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent builds for the same followers collection and target origin", async () => {
    let resolveHeader!: (value: string) => void;
    const headerPromise = new Promise<string>((resolve) => {
      resolveHeader = resolve;
    });
    const buildSenderHeader = vi.fn().mockReturnValue(headerPromise);
    const sender = new FedifyFollowersSyncSender("example.com", { buildSenderHeader });
    const actorUri = "https://example.com/users/alice";
    const followersActivity = activity({ cc: [`${actorUri}/followers`] });

    const first = sender.buildHeader({
      actorUri,
      activity: followersActivity,
      targetInbox: "https://remote.example/users/bob/inbox",
    });
    const second = sender.buildHeader({
      actorUri,
      activity: followersActivity,
      targetInbox: "https://remote.example/inbox",
    });
    const third = sender.buildHeader({
      actorUri,
      activity: followersActivity,
      targetInbox: "https://remote.example/shared/inbox",
    });

    expect(buildSenderHeader).toHaveBeenCalledTimes(1);
    resolveHeader("collectionId=\"x\", digest=\"y\", url=\"z\"");

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "collectionId=\"x\", digest=\"y\", url=\"z\"",
      "collectionId=\"x\", digest=\"y\", url=\"z\"",
      "collectionId=\"x\", digest=\"y\", url=\"z\"",
    ]);
    expect(buildSenderHeader).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce distinct followers collection URIs that share a local identifier", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buildSenderHeader = vi.fn(async (_actorIdentifier: string, followersUri: string) => {
      await gate;
      return followersUri;
    });
    const sender = new FedifyFollowersSyncSender("example.com", { buildSenderHeader });
    const secureActor = "https://example.com/users/alice";
    const alternateActor = "http://example.com/users/alice";

    const first = sender.buildHeader({
      actorUri: secureActor,
      activity: activity({ cc: [`${secureActor}/followers`] }, secureActor),
      targetInbox: "https://remote.example/inbox",
    });
    const second = sender.buildHeader({
      actorUri: alternateActor,
      activity: activity({ cc: [`${alternateActor}/followers`] }, alternateActor),
      targetInbox: "https://remote.example/shared/inbox",
    });

    expect(buildSenderHeader).toHaveBeenCalledTimes(2);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      `${secureActor}/followers`,
      `${alternateActor}/followers`,
    ]);
  });

  it("does not coalesce different target origins", async () => {
    const buildSenderHeader = vi.fn().mockResolvedValue("header");
    const sender = new FedifyFollowersSyncSender("example.com", { buildSenderHeader });
    const actorUri = "https://example.com/users/alice";
    const followersActivity = activity({ cc: [`${actorUri}/followers`] });

    await Promise.all([
      sender.buildHeader({ actorUri, activity: followersActivity, targetInbox: "https://one.example/inbox" }),
      sender.buildHeader({ actorUri, activity: followersActivity, targetInbox: "https://two.example/inbox" }),
    ]);

    expect(buildSenderHeader).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce different local actors", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buildSenderHeader = vi.fn(async () => {
      await gate;
      return "header";
    });
    const sender = new FedifyFollowersSyncSender("example.com", { buildSenderHeader });
    const alice = "https://example.com/users/alice";
    const bob = "https://example.com/users/bob";

    const first = sender.buildHeader({
      actorUri: alice,
      activity: activity({ cc: [`${alice}/followers`] }, alice),
      targetInbox: "https://remote.example/inbox",
    });
    const second = sender.buildHeader({
      actorUri: bob,
      activity: activity({ cc: [`${bob}/followers`] }, bob),
      targetInbox: "https://remote.example/inbox",
    });

    expect(buildSenderHeader).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, second]);
  });

  it("releases the in-flight entry after completion instead of becoming a second cache", async () => {
    const buildSenderHeader = vi.fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const sender = new FedifyFollowersSyncSender("example.com", { buildSenderHeader });
    const actorUri = "https://example.com/users/alice";
    const followersActivity = activity({ cc: [`${actorUri}/followers`] });
    const input = {
      actorUri,
      activity: followersActivity,
      targetInbox: "https://remote.example/inbox",
    };

    await expect(sender.buildHeader(input)).resolves.toBe("first");
    await expect(sender.buildHeader(input)).resolves.toBe("second");
    expect(buildSenderHeader).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight entry after a failure", async () => {
    const buildSenderHeader = vi.fn()
      .mockRejectedValueOnce(new Error("authority unavailable"))
      .mockResolvedValueOnce("recovered");
    const sender = new FedifyFollowersSyncSender("example.com", { buildSenderHeader });
    const actorUri = "https://example.com/users/alice";
    const input = {
      actorUri,
      activity: activity({ cc: [`${actorUri}/followers`] }),
      targetInbox: "https://remote.example/inbox",
    };

    await expect(sender.buildHeader(input)).resolves.toBeNull();
    await expect(sender.buildHeader(input)).resolves.toBe("recovered");
    expect(buildSenderHeader).toHaveBeenCalledTimes(2);
  });

  it("swallows authority failures so FEP remains optional", async () => {
    const sender = new FedifyFollowersSyncSender("example.com", {
      buildSenderHeader: vi.fn().mockRejectedValue(new Error("authority unavailable")),
    });

    await expect(sender.buildHeader({
      actorUri: "https://example.com/users/alice",
      activity: activity({ cc: ["https://example.com/users/alice/followers"] }),
      targetInbox: "https://remote.example/inbox",
    })).resolves.toBeNull();
  });
});
