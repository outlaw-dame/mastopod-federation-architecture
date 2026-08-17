import { describe, expect, it, vi } from "vitest";
import {
  COMPLETED_KEY_PREFIX,
  LEGACY_COMPLETED_KEY_PREFIX,
} from "../../delivery/outbound-delivery-claims.js";
import { AdspRemoteFixtureDurableObserver } from "../RemoteFixtureDurableObserver.js";

function queue(overrides: Record<string, unknown> = {}) {
  return {
    getOutboxIntentState: vi.fn().mockResolvedValue({ completedAt: 1_000, jobCount: 1 }),
    getPendingCount: vi.fn().mockResolvedValue(0),
    getDlqLength: vi.fn().mockResolvedValue(2),
    ...overrides,
  } as any;
}

function redis(exists: (key: string) => number | Promise<number>) {
  return { exists: vi.fn(exists) } as any;
}

describe("AdspRemoteFixtureDurableObserver", () => {
  it("captures the outbound DLQ baseline through the public queue API", async () => {
    const q = queue({ getDlqLength: vi.fn().mockResolvedValue(7) });
    const observer = new AdspRemoteFixtureDurableObserver(q, redis(() => 0));

    await expect(observer.captureBaseline()).resolves.toEqual({ outboundDlqLength: 7 });
    expect(q.getDlqLength).toHaveBeenCalledExactlyOnceWith("outbound");
  });

  it("collects outbox, pending, DLQ delta, and v2 completion state without mutation", async () => {
    const q = queue({ getDlqLength: vi.fn().mockResolvedValue(3) });
    const r = redis(key => key.startsWith(COMPLETED_KEY_PREFIX) ? 1 : 0);
    const observer = new AdspRemoteFixtureDurableObserver(q, r);

    const result = await observer.observe({
      intentId: "intent-1",
      jobId: "job-1",
      baseline: { outboundDlqLength: 2 },
    });

    expect(result).toEqual({
      outboxIntentCompleted: true,
      outboxIntentJobCount: 1,
      deliveryCompleted: true,
      outboundDlqDelta: 1,
      outboundPendingCount: 0,
    });
    expect(q.getOutboxIntentState).toHaveBeenCalledExactlyOnceWith("intent-1");
    expect(q.getPendingCount).toHaveBeenCalledExactlyOnceWith("outbound");
    expect(r.exists).toHaveBeenCalledWith(`${COMPLETED_KEY_PREFIX}job-1`);
    expect(r.exists).toHaveBeenCalledWith(`${LEGACY_COMPLETED_KEY_PREFIX}job-1`);
  });

  it("treats a legacy completion marker as completed without migrating it", async () => {
    const q = queue();
    const r = redis(key => key.startsWith(LEGACY_COMPLETED_KEY_PREFIX) ? 1 : 0);
    const observer = new AdspRemoteFixtureDurableObserver(q, r);

    const result = await observer.observe({
      intentId: "intent-legacy",
      jobId: "job-legacy",
      baseline: { outboundDlqLength: 2 },
    });

    expect(result.deliveryCompleted).toBe(true);
    expect(r.exists).toHaveBeenCalledTimes(2);
  });

  it("reports missing outbox completion and jobCount without inventing defaults", async () => {
    const q = queue({
      getOutboxIntentState: vi.fn().mockResolvedValue({}),
      getDlqLength: vi.fn().mockResolvedValue(2),
    });
    const observer = new AdspRemoteFixtureDurableObserver(q, redis(() => 0));

    await expect(observer.observe({
      intentId: "intent-missing",
      jobId: "job-missing",
      baseline: { outboundDlqLength: 2 },
    })).resolves.toEqual(expect.objectContaining({
      outboxIntentCompleted: false,
      outboxIntentJobCount: null,
      deliveryCompleted: false,
    }));
  });

  it("rejects a regressed DLQ length because delta evidence would be ambiguous", async () => {
    const q = queue({ getDlqLength: vi.fn().mockResolvedValue(1) });
    const observer = new AdspRemoteFixtureDurableObserver(q, redis(() => 0));

    await expect(observer.observe({
      intentId: "intent-regressed",
      jobId: "job-regressed",
      baseline: { outboundDlqLength: 2 },
    })).rejects.toThrow(/DLQ length regressed/u);
  });

  it("rejects malformed counters and identifiers instead of coercing them", async () => {
    const observer = new AdspRemoteFixtureDurableObserver(
      queue({ getPendingCount: vi.fn().mockResolvedValue(-1) }),
      redis(() => 0),
    );

    await expect(observer.observe({
      intentId: "intent",
      jobId: "job",
      baseline: { outboundDlqLength: 2 },
    })).rejects.toThrow(/outbound pending count/u);

    await expect(observer.observe({
      intentId: "",
      jobId: "job",
      baseline: { outboundDlqLength: 2 },
    })).rejects.toThrow(/intentId is required/u);
  });
});
