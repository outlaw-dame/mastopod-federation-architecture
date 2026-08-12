import { describe, expect, it } from "vitest";
import {
  APDM_AUTOMATIC_PRODUCER_REPLAY_MAX_MS,
  APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS,
  APDM_MAX_AUTOMATIC_DUPLICATE_AGE_MS,
  APDM_MAX_CLOCK_SKEW_MS,
  APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS,
  APDM_OUTBOX_INTENT_MAX_AGE_MS,
  APDM_PRODUCER_PROCESSING_ALLOWANCE_MS,
  APDM_REPLAY_SAFETY_MARGIN_MS,
  outboundMessageResidenceMs,
  outboxIntentAgeMs,
  redisStreamMessageTimestampMs,
} from "../apdm-replay-horizon.js";

describe("APDM replay horizon", () => {
  it("keeps producer replay, processing allowance, queue residence, and accepted clock skew inside retention", () => {
    expect(APDM_AUTOMATIC_PRODUCER_REPLAY_MAX_MS).toBe(48 * 60 * 60 * 1000);
    expect(APDM_PRODUCER_PROCESSING_ALLOWANCE_MS).toBe(24 * 60 * 60 * 1000);
    expect(APDM_OUTBOX_INTENT_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000);
    expect(APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS).toBe(48 * 60 * 60 * 1000);
    expect(APDM_MAX_CLOCK_SKEW_MS).toBe(5 * 60 * 1000);
    expect(APDM_MAX_AUTOMATIC_DUPLICATE_AGE_MS).toBe(
      7 * 24 * 60 * 60 * 1000 + 2 * APDM_MAX_CLOCK_SKEW_MS,
    );
    expect(APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS).toBe(8 * 24 * 60 * 60 * 1000);
    expect(APDM_REPLAY_SAFETY_MARGIN_MS).toBe(
      24 * 60 * 60 * 1000 - 2 * APDM_MAX_CLOCK_SKEW_MS,
    );
  });

  it("measures outbox intent age while allowing only bounded future skew", () => {
    const now = 1_000_000;
    expect(outboxIntentAgeMs(997_500, now)).toBe(2_500);
    expect(outboxIntentAgeMs(now + APDM_MAX_CLOCK_SKEW_MS, now)).toBe(0);
    expect(outboxIntentAgeMs(now + APDM_MAX_CLOCK_SKEW_MS + 1, now)).toBeNull();
    expect(outboxIntentAgeMs(Number.NaN, now)).toBeNull();
  });

  it("derives outbound residence only from complete Redis Stream ids", () => {
    expect(redisStreamMessageTimestampMs("1700000000123-4")).toBe(1_700_000_000_123);
    expect(outboundMessageResidenceMs("1700000000123-4", 1_700_000_001_123)).toBe(1_000);
  });

  it("fails closed for malformed, partial, or implausibly future Redis Stream ids", () => {
    const now = 1_700_000_000_000;
    expect(redisStreamMessageTimestampMs("message-1")).toBeNull();
    expect(redisStreamMessageTimestampMs("0-1")).toBeNull();
    expect(redisStreamMessageTimestampMs(`${now}-garbage`)).toBeNull();
    expect(redisStreamMessageTimestampMs(`${now}-1-extra`)).toBeNull();
    expect(redisStreamMessageTimestampMs(`${now}--1`)).toBeNull();
    expect(outboundMessageResidenceMs("message-1", now)).toBe(Number.POSITIVE_INFINITY);
    expect(outboundMessageResidenceMs(`${now + APDM_MAX_CLOCK_SKEW_MS + 1}-1`, now)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
