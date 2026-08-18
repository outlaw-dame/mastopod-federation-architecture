vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { OutboxIntentWorker, type OutboxIntentWorkerConfig } from "../outbox-intent-worker.js";
import {
  normalizeAndDedupeOutboundTargets,
  validateApdmWebhookIdentity,
} from "../outbound-webhook.js";
import type { OutboxIntent } from "../../queue/sidecar-redis-queue.js";
import { DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY } from "../../protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";

class TestWorker extends OutboxIntentWorker {
  run(messageId: string, intent: OutboxIntent): Promise<void> {
    return this.processIntent(messageId, intent);
  }
}

const config: OutboxIntentWorkerConfig = {
  concurrency: 1,
  outboundJobMaxAttempts: 10,
  activityPubOutboundDeliveryPolicy: DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY,
};

function makeQueue() {
  return {
    getOutboxIntentState: vi.fn().mockResolvedValue({}),
    markOutboxIntentEventLogPublished: vi.fn().mockResolvedValue(undefined),
    enqueueOutboundBatchForIntent: vi.fn().mockResolvedValue({ enqueued: true, jobCount: 0 }),
    markOutboxIntentCompleted: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    enqueueOutboxIntent: vi.fn().mockResolvedValue("retry"),
  } as any;
}

function makeRedpanda() {
  return {
    publishToStream1: vi.fn().mockResolvedValue(undefined),
    publishTombstone: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeIntent(visibility: "public" | "unlisted" | "followers" | "direct", createdAt = 1_900_000_000_000): OutboxIntent {
  const isPublicActivity = visibility === "public" || visibility === "unlisted";
  return {
    intentId: "apdm-v1-zero-target-stable",
    activityId: "https://pods.example/as/activity/zero-target",
    actorUri: "https://pods.example/alice",
    activity: JSON.stringify({
      id: "https://pods.example/as/activity/zero-target",
      type: "Create",
      actor: "https://pods.example/alice",
      object: { id: "https://pods.example/notes/1", type: "Note", content: "hello" },
    }),
    targets: [],
    createdAt,
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
    meta: {
      visibility,
      isPublicActivity,
      isPublicIndexable: isPublicActivity,
      deliveryPlanSchema: "ap.delivery-plan.v1",
      deliveryPlanIntentId: "apdm-v1-zero-target-stable",
    } as any,
  };
}

describe("Stream1 local observation authority", () => {
  it("accepts an authenticated zero-target Delivery Plan identity", () => {
    const normalized = normalizeAndDedupeOutboundTargets([], {
      maxTargetsPerRequest: 5000,
      maxPending: 25000,
      maxQueueDepth: 0,
      retryAfterSeconds: 5,
    });

    expect(normalized.targets).toEqual([]);
    expect(normalized.inputTargetCount).toBe(0);
    expect(
      validateApdmWebhookIdentity({
        normalizedTargets: normalized,
        headerIntentId: "apdm-v1-zero-target-stable",
        meta: {
          deliveryPlanSchema: "ap.delivery-plan.v1",
          deliveryPlanIntentId: "apdm-v1-zero-target-stable",
        },
      }),
    ).toBe("apdm-v1-zero-target-stable");
  });

  it("fails closed when zero-target header and Delivery Plan metadata disagree", () => {
    const normalized = normalizeAndDedupeOutboundTargets([], {
      maxTargetsPerRequest: 5000,
      maxPending: 25000,
      maxQueueDepth: 0,
      retryAfterSeconds: 5,
    });

    expect(() =>
      validateApdmWebhookIdentity({
        normalizedTargets: normalized,
        headerIntentId: "apdm-v1-a",
        meta: {
          deliveryPlanSchema: "ap.delivery-plan.v1",
          deliveryPlanIntentId: "apdm-v1-b",
        },
      }),
    ).toThrow(/must match/u);
  });

  for (const visibility of ["public", "unlisted"] as const) {
    it(`publishes zero-target ${visibility} local activity to Stream1 and completes without outbound work`, async () => {
      const createdAt = Date.now() - 1000;
      const queue = makeQueue();
      const redpanda = makeRedpanda();
      const intent = makeIntent(visibility, createdAt);
      const worker = new TestWorker(queue, redpanda, config);

      await worker.run(`msg-${visibility}`, intent);

      expect(redpanda.publishToStream1).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          actorUri: intent.actorUri,
          outboxIntentId: intent.intentId,
          publishedAt: createdAt,
          streamTimestamp: createdAt,
          origin: "local",
        }),
      );
      expect(queue.markOutboxIntentEventLogPublished).toHaveBeenCalledWith(intent.intentId);
      expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledExactlyOnceWith(intent.intentId, []);
      expect(queue.markOutboxIntentCompleted).toHaveBeenCalledWith(intent.intentId);
      expect(queue.moveToDlq).not.toHaveBeenCalled();
    });
  }

  for (const visibility of ["followers", "direct"] as const) {
    it(`does not expose zero-target ${visibility} local activity to Stream1`, async () => {
      const queue = makeQueue();
      const redpanda = makeRedpanda();
      const intent = makeIntent(visibility, Date.now() - 1000);
      const worker = new TestWorker(queue, redpanda, config);

      await worker.run(`msg-${visibility}`, intent);

      expect(redpanda.publishToStream1).not.toHaveBeenCalled();
      expect(queue.markOutboxIntentEventLogPublished).toHaveBeenCalledWith(intent.intentId);
      expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledExactlyOnceWith(intent.intentId, []);
      expect(queue.moveToDlq).not.toHaveBeenCalled();
    });
  }

  it("publishes a public local Delete to Stream1 and emits its tombstone separately", async () => {
    const createdAt = Date.now() - 1000;
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const intent = makeIntent("public", createdAt);
    intent.activityId = "https://pods.example/as/activity/delete-1";
    intent.activity = JSON.stringify({
      id: intent.activityId,
      type: "Delete",
      actor: intent.actorUri,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: "https://pods.example/notes/deleted-1",
    });
    intent.meta = { ...intent.meta, isDeleteOrTombstone: true } as any;
    const worker = new TestWorker(queue, redpanda, config);

    await worker.run("msg-delete", intent);

    expect(redpanda.publishTombstone).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        activityId: intent.activityId,
        objectId: "https://pods.example/notes/deleted-1",
        actorUri: intent.actorUri,
        deletedAt: createdAt,
        streamTimestamp: createdAt,
        outboxIntentId: intent.intentId,
      }),
    );
    expect(redpanda.publishToStream1).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        activity: expect.objectContaining({ type: "Delete" }),
        outboxIntentId: intent.intentId,
        publishedAt: createdAt,
      }),
    );
  });

  it("uses ActivityPods lifecycle authority to tombstone only relevant public Undo while keeping Undo in Stream1", async () => {
    const createdAt = Date.now() - 1000;
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const intent = makeIntent("public", createdAt);
    intent.activityId = "https://pods.example/as/activity/undo-announce-1";
    intent.activity = JSON.stringify({
      id: intent.activityId,
      type: "Undo",
      actor: intent.actorUri,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: "https://pods.example/as/activity/announce-1",
        type: "Announce",
      },
    });
    intent.meta = { ...intent.meta, isDeleteOrTombstone: true } as any;
    const worker = new TestWorker(queue, redpanda, config);

    await worker.run("msg-undo-announce", intent);

    expect(redpanda.publishTombstone).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
  });

  it("does not invent tombstone semantics for an unrelated public Undo", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const intent = makeIntent("public", Date.now() - 1000);
    intent.activity = JSON.stringify({
      id: intent.activityId,
      type: "Undo",
      actor: intent.actorUri,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: "https://pods.example/as/activity/like-1",
        type: "Like",
      },
    });
    intent.meta = { ...intent.meta, isDeleteOrTombstone: false } as any;
    const worker = new TestWorker(queue, redpanda, config);

    await worker.run("msg-undo-like", intent);

    expect(redpanda.publishTombstone).not.toHaveBeenCalled();
    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
  });

  it("publishes the event-log observation before delivery fan-out processing", async () => {
    const queue = makeQueue();
    queue.enqueueOutboundBatchForIntent.mockResolvedValue({ enqueued: true, jobCount: 1 });
    const redpanda = makeRedpanda();
    const createdAt = Date.now() - 1000;
    const intent = {
      ...makeIntent("public", createdAt),
      targets: [
        {
          inboxUrl: "https://remote.example/users/bob/inbox",
          deliveryUrl: "https://remote.example/users/bob/inbox",
          targetDomain: "remote.example",
        },
      ],
    };
    const worker = new TestWorker(queue, redpanda, config);

    await worker.run("msg-fanout-order", intent);

    const publishOrder = redpanda.publishToStream1.mock.invocationCallOrder[0];
    const fanoutOrder = queue.enqueueOutboundBatchForIntent.mock.invocationCallOrder[0];
    expect(publishOrder).toBeDefined();
    expect(fanoutOrder).toBeDefined();
    expect(publishOrder!).toBeLessThan(fanoutOrder!);
  });

  it("preserves stable semantic identity and committed timestamp across a crash-window replay", async () => {
    const createdAt = Date.now() - 1000;
    const intent = makeIntent("public", createdAt);

    const firstQueue = makeQueue();
    firstQueue.markOutboxIntentEventLogPublished.mockRejectedValueOnce(new Error("redis marker unavailable"));
    const firstRedpanda = makeRedpanda();
    const firstWorker = new TestWorker(firstQueue, firstRedpanda, config);
    await firstWorker.run("msg-first", intent);

    const replayQueue = makeQueue();
    const replayRedpanda = makeRedpanda();
    const replayWorker = new TestWorker(replayQueue, replayRedpanda, config);
    await replayWorker.run("msg-replay", { ...intent, attempt: 1, notBeforeMs: 0 });

    const firstRecord = firstRedpanda.publishToStream1.mock.calls[0]?.[0];
    const replayRecord = replayRedpanda.publishToStream1.mock.calls[0]?.[0];
    expect(firstRecord).toEqual(expect.objectContaining({ outboxIntentId: intent.intentId, publishedAt: createdAt }));
    expect(replayRecord).toEqual(expect.objectContaining({ outboxIntentId: intent.intentId, publishedAt: createdAt }));
  });
});
