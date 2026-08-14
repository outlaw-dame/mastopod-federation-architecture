import { describe, expect, it } from "vitest";
import {
  isForbiddenActivityPubAddress,
  isUnsafeActivityPubTargetError,
} from "../activitypub-egress-policy.js";

describe("ActivityPub Phase 5 egress regressions", () => {
  it("rejects the returned 6bone IPv6 prefix", () => {
    expect(isForbiddenActivityPubAddress("3ffe::1")).toBe(true);
  });

  it("treats exact-boundary residence expiry as terminal", () => {
    const error = new Error("outbound residence expired");
    error.name = "OutboundResidenceExpiredError";
    expect(isUnsafeActivityPubTargetError(error)).toBe(true);
  });
});
