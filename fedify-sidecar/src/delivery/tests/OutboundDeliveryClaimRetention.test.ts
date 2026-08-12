import { describe, expect, it } from "vitest";
import {
  COMPLETED_DELIVERY_BLACKOUT_STARTED_AT_ENV,
  COMPLETED_DELIVERY_CUTOVER_MODE,
  COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY,
  COMPLETED_DELIVERY_FRESH_INSTALL_MODE,
  COMPLETED_KEY_PREFIX,
  LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS,
  LEGACY_COMPLETED_KEY_PREFIX,
  MIN_COMPLETED_DELIVERY_TTL_MS,
  normalizeCompletedDeliveryTtlMs,
  validateCompletedDeliveryCutoverRequest,
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

  it("pins explicit fresh and maintenance first-start modes", () => {
    expect(COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY).toBe(
      "ap:delivery:completed:v2:migration-complete",
    );
    expect(COMPLETED_DELIVERY_CUTOVER_MODE).toBe("maintenance");
    expect(COMPLETED_DELIVERY_FRESH_INSTALL_MODE).toBe("fresh");
    expect(COMPLETED_DELIVERY_BLACKOUT_STARTED_AT_ENV).toBe(
      "APDM_COMPLETION_MARKER_V2_BLACKOUT_STARTED_AT_MS",
    );
  });

  it("requires an explicit first-start declaration before the migration sentinel exists", () => {
    expect(() => validateCompletedDeliveryCutoverRequest(undefined, undefined, Date.now())).toThrow(
      "First v2 startup requires",
    );
  });

  it("accepts a proven fresh-install declaration without a blackout", () => {
    expect(validateCompletedDeliveryCutoverRequest("fresh", undefined, Date.now())).toEqual({
      mode: "fresh",
    });
  });

  it("requires an upgrade blackout strictly beyond 48 hours plus accepted skew", () => {
    const nowMs = 2_000_000_000_000;
    expect(LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS).toBe(48 * 60 * 60 * 1000 + 5 * 60 * 1000);

    expect(() => validateCompletedDeliveryCutoverRequest(
      "maintenance",
      String(nowMs - LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS + 1),
      nowMs,
    )).toThrow("blackout must remain in force");

    expect(() => validateCompletedDeliveryCutoverRequest(
      "maintenance",
      String(nowMs - LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS),
      nowMs,
    )).toThrow("blackout must remain in force");

    expect(validateCompletedDeliveryCutoverRequest(
      "maintenance",
      String(nowMs - LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS - 1),
      nowMs,
    )).toEqual({
      mode: "maintenance",
      blackoutStartedAtMs: nowMs - LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS - 1,
    });
  });

  it("rejects an invalid or future upgrade blackout timestamp", () => {
    const nowMs = 2_000_000_000_000;
    expect(() => validateCompletedDeliveryCutoverRequest("maintenance", "not-a-time", nowMs)).toThrow(
      COMPLETED_DELIVERY_BLACKOUT_STARTED_AT_ENV,
    );
    expect(() => validateCompletedDeliveryCutoverRequest(
      "maintenance",
      String(nowMs + 1),
      nowMs,
    )).toThrow("blackout must remain in force");
  });
});
