vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import {
  OutboxIntentWorker,
  type OutboxIntentWorkerConfig,
} from "../outbox-intent-worker.js";
import type { OutboxIntent } from "../../queue/sidecar-redis-queue.js";
import { DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY } from "../../protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";
import { APDM_OUTBOX_INTENT_MAX_AGE_MS } from "../apdm-replay-horizon.js";

class TestOutboxIntentWorker extends OutboxIntentWorker {
  async runIntent(messageId: string, intent: OutboxIntent): Promise<void> {
    return this.processIntent(messageId, intent);
  }
}

function makeIntent(overrides: Partial<OutboxIntent> = {}): OutboxIntent {
  return {
    intentId: "intent-001",
    activityId: "https://example.com/activities/1",
    actorUri: "https://example.com/users/alice",
    activity: JSON.stringify({
      id: "https://example.com/activities/1",
      type: "Create",
      actor: "https://example.com/users/alice",
      object: {
        id: "https://example.com/objects/1",
        type: "Note",
        content: "Hello",
      },
    }),
    targets: [
      {
        inboxUrl: "https://remote.example/users/bob/inbox",
        sharedInboxUrl: "https://remote.example/inbox",
        deliveryUrl: "https://remote.example/inbox",
        targetDomain: "remote.example",
      },
    ],
    createdAt: Date.now() - 100,
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
    meta: {
      isPublicActivity: true,
      isPublicIndexable: true,
      visibility: "public",
    },
    ...overrides,
  };
}

function makeQueue(overrides: Record<string, unknown> = {}) {
  return {
    consumeOutboxIntents: async function* () {},
    getOutboxIntentState: vi.fn().mockResolvedValue({}),
    markOutboxIntentEventLogPublished: vi.fn().mockResolvedValue(undefined),
    enqueueOutboundBatchForIntent: vi.fn().mockResolvedValue({ enqueued: true, jobCount: 1 }),
    markOutboxIntentCompleted: vi.fn().mockResolvedValue(undefined),
    enqueueOutboxIntent: vi.fn().mockResolvedValue("retry-msg-1"),
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeRedpanda(overrides: Record<string, unknown> = {}) {
  return {
    publishToStream1: vi.fn().mockResolvedValue(undefined),
    publishTombstone: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeConfig(overrides: Partial<OutboxIntentWorkerConfig> = {}): OutboxIntentWorkerConfig {
  return {
    concurrency: 1,
    outboundJobMaxAttempts: 10,
    activityPubOutboundDeliveryPolicy: DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY,
    ...overrides,
  };
}

function expectCalledBefore(first: ReturnType<typeof vi.fn>, second: ReturnType<typeof vi.fn>) {
  expect(first).toHaveBeenCalled();
  expect(second).toHaveBeenCalled();
  const firstOrder = first.mock.invocationCallOrder[0];
  const secondOrder = second.mock.invocationCallOrder[0];
  if (firstOrder === undefined || secondOrder === undefined) {
    throw new Error("Expected both mocks to have invocation order entries");
  }
  expect(firstOrder).toBeLessThan(secondOrder);
}

describe("OutboxIntentWorker", () => {
  it("publishes the event log and atomically fans out outbound jobs on success", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const worker = new TestOutboxIntentWorker(queue, redpanda, makeConfig());
    const intent = makeIntent();

    await worker.runIntent("msg-001", intent);

    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream1).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUri: intent.actorUri,
        outboxIntentId: intent.intentId,
      }),
    );
    expect(queue.markOutboxIntentEventLogPublished).toHaveBeenCalledWith(intent.intentId);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledTimes(1);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledWith(
      intent.intentId,
      expect.arrayContaining([
        expect.objectContaining({
          activityId: intent.activityId,
          actorUri: intent.actorUri,
          targetInbox: "https://remote.example/inbox",
          targetDomain: "remote.example",
          maxAttempts: 10,
        }),
      ]),
    );
    expect(queue.markOutboxIntentCompleted).toHaveBeenCalledWith(intent.intentId);
    expect(queue.ack).toHaveBeenCalledWith("outbox_intent", "msg-001");
    expect(queue.enqueueOutboxIntent).not.toHaveBeenCalled();
    expect(queue.moveToDlq).not.toHaveBeenCalled();
  });

  it("publishes observation-only intents and completes with an atomic zero-job fan-out", async () => {
    const queue = makeQueue({
      enqueueOutboundBatchForIntent: vi.fn().mockResolvedValue({ enqueued: true, jobCount: 0 }),
    });
    const redpanda = makeRedpanda();
    const sharedInboxCache = {
      enrichTargets: vi.fn().mockRejectedValue(new Error("must not run")),
    } as any;
    const worker = new TestOutboxIntentWorker(
      queue,
      redpanda,
      makeConfig({ sharedInboxCache }),
    );
    const intent = makeIntent({
      intentId: "apdm-observation:01TESTEVENT",
      targets: [],
      bridgeHints: { observationOnly: true },
    });

    await worker.runIntent("msg-observation", intent);

    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream1).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUri: intent.actorUri,
        outboxIntentId: intent.intentId,
      }),
    );
    expect(queue.markOutboxIntentEventLogPublished).toHaveBeenCalledWith(intent.intentId);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledExactlyOnceWith(intent.intentId, []);
    expect(queue.markOutboxIntentCompleted).toHaveBeenCalledWith(intent.intentId);
    expect(queue.ack).toHaveBeenCalledWith("outbox_intent", "msg-observation");
    expect(sharedInboxCache.enrichTargets).not.toHaveBeenCalled();
    expect(queue.moveToDlq).not.toHaveBeenCalled();
  });

  it("does not let a target-bearing intent opt into observation-only via bridge hints", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const sharedInboxCache = {
      enrichTargets: vi.fn().mockResolvedValue([
        {
          inboxUrl: "https://remote.example/users/bob/inbox",
          sharedInboxUrl: "https://remote.example/inbox",
          deliveryUrl: "https://remote.example/inbox",
          targetDomain: "remote.example",
        },
      ]),
    } as any;
    const worker = new TestOutboxIntentWorker(
      queue,
      redpanda,
      makeConfig({ sharedInboxCache }),
    );
    const intent = makeIntent({ bridgeHints: { observationOnly: true } });

    await worker.runIntent("msg-target-bearing-reserved-hint", intent);

    expect(sharedInboxCache.enrichTargets).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledTimes(1);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledWith(
      intent.intentId,
      expect.arrayContaining([
        expect.objectContaining({
          targetInbox: "https://remote.example/inbox",
          targetDomain: "remote.example",
        }),
      ]),
    );
    expect(queue.moveToDlq).not.toHaveBeenCalled();
  });

  it("persists a transient retry before acknowledging the source intent", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda({
      publishToStream1: vi.fn().mockRejectedValue(new Error("broker unavailable")),
    });
    const worker = new TestOutboxIntentWorker(queue, redpanda, makeConfig());
    const intent = makeIntent();

    const before = Date.now();
    await worker.runIntent("msg-002", intent);

    expect(queue.ack).toHaveBeenCalledWith("outbox_intent", "msg-002");
    expect(queue.enqueueOutboxIntent).toHaveBeenCalledTimes(1);
    expectCalledBefore(queue.enqueueOutboxIntent, queue.ack);
    const retryIntent = queue.enqueueOutboxIntent.mock.calls[0]?.[0] as OutboxIntent | undefined;
    expect(retryIntent).toBeDefined();
    if (!retryIntent) throw new Error("Expected retry intent to be enqueued");
    expect(retryIntent.intentId).toBe(intent.intentId);
    expect(retryIntent.attempt).toBe(1);
    expect(retryIntent.lastError).toContain("broker unavailable");
    expect(retryIntent.notBeforeMs).toBeGreaterThan(before);
    expect(queue.moveToDlq).not.toHaveBeenCalled();
    expect(queue.enqueueOutboundBatchForIntent).not.toHaveBeenCalled();
  });

  it("persists a deferred replacement before acknowledging the source intent", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const worker = new TestOutboxIntentWorker(queue, redpanda, makeConfig());
    const intent = makeIntent({ notBeforeMs: Date.now() + 60_000 });

    await worker.runIntent("msg-deferred", intent);

    expect(queue.enqueueOutboxIntent).toHaveBeenCalledWith(intent);
    expect(queue.ack).toHaveBeenCalledWith("outbox_intent", "msg-deferred");
    expectCalledBefore(queue.enqueueOutboxIntent, queue.ack);
    expect(queue.enqueueOutboundBatchForIntent).not.toHaveBeenCalled();
  });

  it("persists stale intent recovery in the DLQ before acknowledging the source", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const worker = new TestOutboxIntentWorker(queue, redpanda, makeConfig());
    const intent = makeIntent({
      createdAt: Date.now() - APDM_OUTBOX_INTENT_MAX_AGE_MS - 1_000,
    });

    await worker.runIntent("msg-stale", intent);

    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    expect(queue.ack).toHaveBeenCalledWith("outbox_intent", "msg-stale");
    expectCalledBefore(queue.moveToDlq, queue.ack);
    expect(queue.enqueueOutboxIntent).not.toHaveBeenCalled();
    expect(queue.enqueueOutboundBatchForIntent).not.toHaveBeenCalled();
  });

  it("leaves the source pending if the DLQ write fails", async () => {
    const queue = makeQueue({
      moveToDlq: vi.fn().mockRejectedValue(new Error("dlq unavailable")),
    });
    const redpanda = makeRedpanda();
    const worker = new TestOutboxIntentWorker(queue, redpanda, makeConfig());
    const intent = makeIntent({
      createdAt: Date.now() - APDM_OUTBOX_INTENT_MAX_AGE_MS - 1_000,
    });

    await expect(worker.runIntent("msg-stale-failure", intent)).rejects.toThrow("dlq unavailable");

    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    expect(queue.ack).not.toHaveBeenCalled();
  });

  it("acks duplicate completed intents without re-publishing or re-enqueueing", async () => {
    const completedAt = Date.now() - 10;
    const queue = makeQueue({
      getOutboxIntentState: vi.fn().mockResolvedValue({ completedAt }),
    });
    const redpanda = makeRedpanda();
    const worker = new TestOutboxIntentWorker(queue, redpanda, makeConfig());
    const intent = makeIntent({ createdAt: completedAt - 10 });

    await worker.runIntent("msg-003", intent);

    expect(queue.ack).toHaveBeenCalledWith("outbox_intent", "msg-003");
    expect(redpanda.publishToStream1).not.toHaveBeenCalled();
    expect(queue.enqueueOutboundBatchForIntent).not.toHaveBeenCalled();
    expect(queue.markOutboxIntentCompleted).not.toHaveBeenCalled();
  });

  it("still publishes public activities to Stream1 when search indexing is disabled", async () => {
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const worker = new TestOutboxIntentWorker(queue, redpanda, makeConfig());
    const intent = makeIntent({
      meta: {
        isPublicActivity: true,
        isPublicIndexable: false,
        visibility: "public",
      },
    });

    await worker.runIntent("msg-004", intent);

    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
    expect(queue.enqueueOutboundBatchForIntent).toHaveBeenCalledTimes(1);
  });
});
