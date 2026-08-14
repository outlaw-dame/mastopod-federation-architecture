import { describe, expect, it, vi } from "vitest";
import { createPinnedLookup, validateActivityPubTarget } from "../activitypub-egress-policy.js";

describe("ActivityPub pinned DNS boundary", () => {
  it("does not consult changed DNS state after validation", async () => {
    const firstAddress = ["8", "8", "8", "8"].join(".");
    const reboundAddress = ["1", "1", "1", "1"].join(".");
    const resolver = vi.fn(async () => [{ address: firstAddress, family: 4 as const }]);
    const target = await validateActivityPubTarget("https://example.com/inbox", { lookup: resolver });
    resolver.mockImplementation(async () => [{ address: reboundAddress, family: 4 as const }]);

    const lookup = createPinnedLookup(target);
    const callback = vi.fn();
    lookup("example.com", { all: true }, callback);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, [{ address: firstAddress, family: 4 }]);
  });
});
