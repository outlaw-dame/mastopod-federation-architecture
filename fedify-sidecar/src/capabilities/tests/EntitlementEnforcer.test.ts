import { describe, it, expect } from "vitest";
import {
  resolveEffectiveLimits,
  checkCapabilityLimit,
  buildEntitlementOverridesFromEnv,
} from "../entitlement.js";
import type { EntitlementOverride } from "../types.js";

// ---------------------------------------------------------------------------
// resolveEffectiveLimits
// ---------------------------------------------------------------------------

describe("resolveEffectiveLimits", () => {
  it("returns correct base limits for 'basic' plan", () => {
    const limits = resolveEffectiveLimits("basic", "ap.feeds.realtime", []);
    expect(limits["maxSseConnections"]).toBe(10);
    expect(limits["maxWsConnections"]).toBe(5);
    expect(limits["maxStreamsPerConnection"]).toBe(2);
  });

  it("returns correct base limits for 'enterprise' plan", () => {
    const limits = resolveEffectiveLimits("enterprise", "ap.feeds.realtime", []);
    expect(limits["maxSseConnections"]).toBe(1_000);
    expect(limits["maxWsConnections"]).toBe(500);
  });

  it("falls back to 'standard' for unknown plan names", () => {
    const limits = resolveEffectiveLimits("unknown-plan-xyz", "ap.feeds.realtime", []);
    const standard = resolveEffectiveLimits("standard", "ap.feeds.realtime", []);
    expect(limits).toEqual(standard);
  });

  it("returns empty object for unknown capability", () => {
    const limits = resolveEffectiveLimits("pro", "ap.capability.does.not.exist", []);
    expect(limits).toEqual({});
  });

  it("applies limit overrides on top of base plan", () => {
    const overrides: EntitlementOverride[] = [
      { capabilityId: "ap.feeds.realtime", type: "limit", field: "maxSseConnections", value: 999 },
    ];
    const limits = resolveEffectiveLimits("basic", "ap.feeds.realtime", overrides);
    expect(limits["maxSseConnections"]).toBe(999);
    // Other fields from base plan are unchanged
    expect(limits["maxWsConnections"]).toBe(5);
  });

  it("ignores overrides for other capabilities", () => {
    const overrides: EntitlementOverride[] = [
      { capabilityId: "ap.streams", type: "limit", field: "retentionDays", value: 999 },
    ];
    const limits = resolveEffectiveLimits("basic", "ap.feeds.realtime", overrides);
    expect(limits["maxSseConnections"]).toBe(10);
  });

  it("ignores non-limit override types", () => {
    const overrides: EntitlementOverride[] = [
      { capabilityId: "ap.feeds.realtime", type: "enable", field: "maxSseConnections", value: 999 },
    ];
    const limits = resolveEffectiveLimits("basic", "ap.feeds.realtime", overrides);
    // "enable" type is not applied as a limit
    expect(limits["maxSseConnections"]).toBe(10);
  });

  it("applies multiple overrides in order", () => {
    const overrides: EntitlementOverride[] = [
      { capabilityId: "ap.feeds.realtime", type: "limit", field: "maxSseConnections", value: 100 },
      { capabilityId: "ap.feeds.realtime", type: "limit", field: "maxSseConnections", value: 200 },
    ];
    const limits = resolveEffectiveLimits("basic", "ap.feeds.realtime", overrides);
    // Last write wins
    expect(limits["maxSseConnections"]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// checkCapabilityLimit
// ---------------------------------------------------------------------------

describe("checkCapabilityLimit", () => {
  it("allows when actualValue is within limit", () => {
    const result = checkCapabilityLimit("basic", "ap.feeds.realtime", "maxSseConnections", 5, []);
    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe("allowed");
    expect(result.effectiveLimit).toBe(10);
    expect(result.actualValue).toBe(5);
  });

  it("allows when actualValue equals limit (inclusive)", () => {
    const result = checkCapabilityLimit("basic", "ap.feeds.realtime", "maxSseConnections", 10, []);
    expect(result.allowed).toBe(true);
  });

  it("denies when actualValue exceeds limit", () => {
    const result = checkCapabilityLimit("basic", "ap.feeds.realtime", "maxSseConnections", 11, []);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("limit_exceeded");
    expect(result.effectiveLimit).toBe(10);
    expect(result.actualValue).toBe(11);
    expect(result.capabilityId).toBe("ap.feeds.realtime");
    expect(result.limitField).toBe("maxSseConnections");
  });

  it("allows any value for unknown capability (defaults to MAX_SAFE_INTEGER)", () => {
    const result = checkCapabilityLimit("basic", "ap.unknown.capability", "someField", 1_000_000, []);
    expect(result.allowed).toBe(true);
    expect(result.effectiveLimit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("allows any value when limit field is non-numeric (defaults to MAX_SAFE_INTEGER)", () => {
    // "transports" is a string field on ap.feeds.realtime
    const result = checkCapabilityLimit("basic", "ap.feeds.realtime", "transports", 9999, []);
    expect(result.allowed).toBe(true);
    expect(result.effectiveLimit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("respects entitlement overrides", () => {
    const overrides: EntitlementOverride[] = [
      { capabilityId: "ap.feeds.realtime", type: "limit", field: "maxSseConnections", value: 3 },
    ];
    const result = checkCapabilityLimit("pro", "ap.feeds.realtime", "maxSseConnections", 4, overrides);
    expect(result.allowed).toBe(false);
    expect(result.effectiveLimit).toBe(3);
  });

  it("handles pro plan WebSocket limits", () => {
    const within = checkCapabilityLimit("pro", "ap.feeds.realtime", "maxWsConnections", 99, []);
    const over = checkCapabilityLimit("pro", "ap.feeds.realtime", "maxWsConnections", 101, []);
    expect(within.allowed).toBe(true);
    expect(over.allowed).toBe(false);
    expect(over.effectiveLimit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// buildEntitlementOverridesFromEnv
// ---------------------------------------------------------------------------

describe("buildEntitlementOverridesFromEnv", () => {
  it("returns empty array when env var is absent", () => {
    const overrides = buildEntitlementOverridesFromEnv({});
    expect(overrides).toEqual([]);
  });

  it("parses a valid JSON array of overrides", () => {
    const overrides = buildEntitlementOverridesFromEnv({
      ENTITLEMENT_OVERRIDES: JSON.stringify([
        { capabilityId: "ap.feeds.realtime", type: "limit", field: "maxSseConnections", value: 50 },
      ]),
    });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.capabilityId).toBe("ap.feeds.realtime");
    expect(overrides[0]!.value).toBe(50);
  });

  it("returns empty array on invalid JSON", () => {
    const overrides = buildEntitlementOverridesFromEnv({ ENTITLEMENT_OVERRIDES: "not-json" });
    expect(overrides).toEqual([]);
  });

  it("returns empty array when value is not an array", () => {
    const overrides = buildEntitlementOverridesFromEnv({
      ENTITLEMENT_OVERRIDES: JSON.stringify({ capabilityId: "x", type: "limit", field: "y", value: 1 }),
    });
    expect(overrides).toEqual([]);
  });

  it("filters out malformed entries silently", () => {
    const overrides = buildEntitlementOverridesFromEnv({
      ENTITLEMENT_OVERRIDES: JSON.stringify([
        { capabilityId: "ap.feeds.realtime", type: "limit", field: "maxSseConnections", value: 10 },
        { notAnOverride: true },
        null,
        42,
        { capabilityId: 123, type: "limit", field: "x", value: 1 },
      ]),
    });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.capabilityId).toBe("ap.feeds.realtime");
  });

  it("accepts multiple valid overrides for different capabilities", () => {
    const overrides = buildEntitlementOverridesFromEnv({
      ENTITLEMENT_OVERRIDES: JSON.stringify([
        { capabilityId: "ap.feeds.realtime", type: "limit", field: "maxSseConnections", value: 20 },
        { capabilityId: "ap.streams", type: "limit", field: "retentionDays", value: 60 },
      ]),
    });
    expect(overrides).toHaveLength(2);
  });
});
