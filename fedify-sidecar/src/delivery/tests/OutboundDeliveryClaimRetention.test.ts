import { describe, expect, it } from "vitest";
import {
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
});
