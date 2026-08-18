vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { OutboxIntentWorker } from "../outbox-intent-worker.js";
import type { OutboxIntent } from "../../queue/sidecar-redis-queue.js";
import { DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY } from "../../protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";

class TestOutboxIntentWorker extends OutboxIntentWorker {
  runIntent(messageId: string, intent: OutboxIntent): Promise<void> {
    return this.processIntent(messageId, intent);
  }
}

describe("OutboxIntentWorker delayed parking failure", () => {
  it("leaves the source pending without consuming a business retry attempt", async () => {
    const queue = {
      moveToDlq: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn().mockResolvedValue(undefined),
      getOutboxIntentState: vi.fn().mockResolvedValue({}),
      enqueueOutboundBatchForIntent: vi.fn(),
    } as any;
    const parkingError = new Error("redis parking unavailable");
    const delayScheduler = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      promoteDue: vi.fn().mockResolvedValue(0),
      persistReplacementAndAck: vi.fn().mockRejectedValue(parkingError),
    } as any;
    const worker = new TestOutboxIntentWorker(queue, null, {
      concurrency: 1,
      outboundJobMaxAttempts: 10,
      activityPubOutboundDeliveryPolicy: DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY,
      delayScheduler,
    });
    const intent: OutboxIntent = {
      intentId: "intent-future",
      activityId: "https://example.com/activities/future",
      actorUri: "https://example.com/users/alice",
      activity: JSON.stringify({
        id: "https://example.com/activities/future",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: { type: "Note", content: "future" },
      }),
      targets: [],
      createdAt: Date.now() - 100,
      attempt: 3,
      maxAttempts: 8,
      notBeforeMs: Date.now() + 60_000,
    };

    await expect(worker.runIntent("msg-future", intent)).rejects.toBe(parkingError);

    expect(delayScheduler.persistReplacementAndAck).toHaveBeenCalledTimes(1);
    expect(delayScheduler.persistReplacementAndAck).toHaveBeenCalledWith("msg-future", intent);
    expect(intent.attempt).toBe(3);
    expect(queue.moveToDlq).not.toHaveBeenCalled();
    expect(queue.ack).not.toHaveBeenCalled();
    expect(queue.getOutboxIntentState).not.toHaveBeenCalled();
    expect(queue.enqueueOutboundBatchForIntent).not.toHaveBeenCalled();
  });
});
