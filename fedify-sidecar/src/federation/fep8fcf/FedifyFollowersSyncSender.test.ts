import { describe, expect, it, vi } from "vitest";
import { FedifyFollowersSyncSender } from "./FedifyFollowersSyncSender.js";
import { isFollowersAddressedActivity } from "./FollowersSyncOutboundEligibility.js";

function activity(recipients: Record<string, unknown>): string {
  return JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://example.com/activities/1",
    type: "Create",
    actor: "https://example.com/users/alice",
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
