import { describe, expect, it } from "vitest";
import {
  COMPLETED_DELIVERY_RETENTION_SWEEP_INTERVAL_MS,
  MIN_COMPLETED_DELIVERY_TTL_MS,
  normalizeCompletedDeliveryTtlMs,
  shouldExtendCompletedDeliveryTtl,
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

  it("identifies legacy finite TTLs that must be extended during rolling deployment", () => {
    expect(shouldExtendCompletedDeliveryTtl(24 * 60 * 60 * 1000)).toBe(true);
    expect(shouldExtendCompletedDeliveryTtl(MIN_COMPLETED_DELIVERY_TTL_MS - 1)).toBe(true);
    expect(shouldExtendCompletedDeliveryTtl(MIN_COMPLETED_DELIVERY_TTL_MS)).toBe(false);
    expect(shouldExtendCompletedDeliveryTtl(10 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(shouldExtendCompletedDeliveryTtl(-1)).toBe(false);
    expect(shouldExtendCompletedDeliveryTtl(-2)).toBe(false);
    expect(shouldExtendCompletedDeliveryTtl(Number.NaN)).toBe(false);
  });

  it("sweeps much faster than the former 24-hour marker lifetime", () => {
    expect(COMPLETED_DELIVERY_RETENTION_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(COMPLETED_DELIVERY_RETENTION_SWEEP_INTERVAL_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
