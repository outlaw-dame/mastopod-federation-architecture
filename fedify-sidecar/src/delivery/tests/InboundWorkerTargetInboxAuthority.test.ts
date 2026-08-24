import { describe, expect, it } from "vitest";
import { resolveActivityPodsTargetInbox } from "../inbound-worker.js";

describe("InboundWorker ActivityPods target inbox authority", () => {
  it("separates the public inbox identity from the internal API transport", () => {
    expect(resolveActivityPodsTargetInbox("https://activitypods.example", "/alice/inbox"))
      .toBe("https://activitypods.example/alice/inbox");
    expect(resolveActivityPodsTargetInbox("https://activitypods.example", "/users/alice/inbox"))
      .toBe("https://activitypods.example/users/alice/inbox");
    expect(resolveActivityPodsTargetInbox("https://activitypods.example", "/inbox"))
      .toBe("https://activitypods.example/inbox");
  });

  it.each([
    ["https://user:pass@activitypods.example", "/alice/inbox"],
    ["https://activitypods.example/base", "/alice/inbox"],
    ["https://activitypods.example?authority=other", "/alice/inbox"],
    ["https://activitypods.example", "//evil.example/alice/inbox"],
    ["https://activitypods.example", "/alice/outbox"],
    ["file:///tmp/activitypods", "/alice/inbox"],
  ])("fails closed for base %s and path %s", (base, path) => {
    expect(() => resolveActivityPodsTargetInbox(base, path)).toThrow(/Invalid ActivityPods/u);
  });
});
