import { describe, expect, it } from "vitest";
import {
  COMPLETED_DELIVERY_CUTOVER_MODE,
  COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY,
  COMPLETED_KEY_PREFIX,
  LEGACY_COMPLETED_KEY_PREFIX,
  MIN_COMPLETED_DELIVERY_TTL_MS,
  normalizeCompletedDeliveryTtlMs,
} from "../outbound-delivery-claims.js";

describe("APDM completed-delivery retention policy", () => {
  it("enforces an eight-day minimum retention horizon", () => {
    expect(MIN_COMPLETED_DELIVERY_TTL_MS).toBe(8 * 24 * 60 * 60 * 1000);
    expect(normalizeCompletedDeliveryTtlMs(24 * 60 * 60 * 1000)).toBe(
      MIN_COMPLETED_DELIVERY_TTL_MS,
    );
  });

  it("preserves a longer explicitly configured retention horizon", () => {
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    expect(normalizeCompletedDeliveryTtlMs(tenDays)).toBe(tenDays);
  });

  it("fails safe to the eight-day floor for non-finite input", () => {
    expect(normalizeCompletedDeliveryTtlMs(Number.NaN)).toBe(MIN_COMPLETED_DELIVERY_TTL_MS);
    expect(normalizeCompletedDeliveryTtlMs(Number.POSITIVE_INFINITY)).toBe(
      MIN_COMPLETED_DELIVERY_TTL_MS,
    );
  });

  it("uses a distinct v2 namespace so upgraded markers are never refreshed by legacy migration", () => {
    expect(LEGACY_COMPLETED_KEY_PREFIX).toBe("ap:delivery:completed:");
    expect(COMPLETED_KEY_PREFIX).toBe("ap:delivery:completed:v2:");
    expect(COMPLETED_KEY_PREFIX).not.toBe(LEGACY_COMPLETED_KEY_PREFIX);
  });

  it("pins the one-time migration sentinel and explicit maintenance cutover mode", () => {
    expect(COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY).toBe(
      "ap:delivery:completed:v2:migration-complete",
    );
    expect(COMPLETED_DELIVERY_CUTOVER_MODE).toBe("maintenance");
  });
});
