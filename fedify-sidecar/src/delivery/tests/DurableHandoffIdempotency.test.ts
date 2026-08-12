vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { OutboxIntentWorker, type OutboxIntentWorkerConfig } from "../outbox-intent-worker.js";
import { OutboundWorker, type DeliveryResult, type OutboundWorkerConfig } from "../outbound-worker.js";
import type { OutboxIntent, OutboundJob } from "../../queue/sidecar-redis-queue.js";
import type { OutboundDeliveryClaimStore, DeliveryClaimResult } from "../outbound-delivery-claims.js";
import { DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY } from "../../protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";
import {
  APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS,
  APDM_OUTBOX_INTENT_MAX_AGE_MS,
} from "../apdm-replay-horizon.js";

class TestIntentWorker extends OutboxIntentWorker {
  async run(messageId: string, intent: OutboxIntent): Promise<void> {
    await this.processIntent(messageId, intent);
  }
}

class TestOutboundWorker extends OutboundWorker {
  deliveries = 0;

  async run(messageId: string, job: OutboundJob): Promise<void> {
    await this.processJob(messageId, job);
  }

  protected override async deliver(job: OutboundJob): Promise<DeliveryResult> {
    this.deliveries += 1;
    return {
      jobId: job.jobId,
      success: true,
      statusCode: 202,
      permanent: false,
    };
  }
}

class StatefulClaimStore implements OutboundDeliveryClaimStore {
  private readonly claims = new Map<string, string>();
  private readonly completed = new Set<string>();
  claimCalls = 0;

  seedInFlight(jobId: string, token = "dead-worker-token"): void {
    this.claims.set(jobId, token);
  }

  expireInFlight(jobId: string): void {
    this.claims.delete(jobId);
  }

  isCompleted(jobId: string): boolean {
    return this.completed.has(jobId);
  }

  async claim(jobId: string, claimToken: string): Promise<DeliveryClaimResult> {
    this.claimCalls += 1;
    if (this.completed.has(jobId)) return "completed";
    if (this.claims.has(jobId)) return "in_flight";
    this.claims.set(jobId, claimToken);
    return "claimed";
  }

  async complete(jobId: string, claimToken: string): Promise<void> {
    if (this.claims.get(jobId) !== claimToken) {
      throw new Error("claim ownership lost");
    }
    this.completed.add(jobId);
    this.claims.delete(jobId);
  }

  async release(jobId: string, claimToken: string): Promise<void> {
    if (this.claims.get(jobId) === claimToken) this.claims.delete(jobId);
  }

  async close(): Promise<void> {}
}

function intent(intentId: string): OutboxIntent {
  return {
    intentId,
    activityId: "https://pods.example/alice/activities/1",
    actorUri: "https://pods.example/alice",
    activity: JSON.stringify({
      id: "https://pods.example/alice/activities/1",
      type: "Create",
      actor: "https://pods.example/alice",
      object: { type: "Note", content: "hello" },
    }),
    targets: [
      {
        inboxUrl: "https://remote.example/users/bob/inbox",
        sharedInboxUrl: "https://remote.example/inbox",
        deliveryUrl: "https://remote.example/inbox",
        targetDomain: "remote.example",
      },
    ],
    createdAt: Date.now(),
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
    meta: {
      isPublicActivity: false,
      visibility: "followers",
      deliveryPlanIntentId: "apdm-v1-stable-plan-id",
    } as any,
  };
}

function intentWorkerConfig(): OutboxIntentWorkerConfig {
  return {
    concurrency: 1,
    outboundJobMaxAttempts: 10,
    activityPubOutboundDeliveryPolicy: DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY,
  };
}

function outboundWorkerConfig(deliveryClaimStore: OutboundDeliveryClaimStore): OutboundWorkerConfig {
  return {
    concurrency: 1,
    maxConcurrentPerDomain: 2,
    requestTimeoutMs: 1000,
    userAgent: "apdm-test",
    fedifyRuntimeIntegrationEnabled: false,
    deliveryClaimStore,
    deliveryClaimTtlMs: 1000,
    deliveryCompletedTtlMs: 60_000,
    notReadyMinDelayMs: 1,
    notReadyJitterMs: 0,
  };
}

function outboundJob(): OutboundJob {
  return {
    jobId: "https://pods.example/alice/activities/1::https://remote.example/inbox",
    activityId: "https://pods.example/alice/activities/1",
    actorUri: "https://pods.example/alice",
    activity: JSON.stringify({ type: "Create" }),
    targetInbox: "https://remote.example/inbox",
    targetDomain: "remote.example",
    attempt: 0,
    maxAttempts: 10,
    notBeforeMs: 0,
    meta: { deliveryPlanIntentId: "apdm-v1-stable-plan-id" } as any,
  };
}

function createOutboundQueue() {
  return {
    isDomainBlocked: vi.fn().mockResolvedValue(false),
    checkDomainRateLimit: vi.fn().mockResolvedValue(true),
    acquireDomainSlot: vi.fn().mockResolvedValue(true),
    releaseDomainSlot: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("APDM Phase 4 durable handoff idempotency", () => {
  it("different sidecar intent records for one Delivery Plan derive the same outbound job ID", async () => {
    const captured: OutboundJob[][] = [];
    const queue = {
      getOutboxIntentState: vi.fn().mockResolvedValue({}),
      enqueueOutboundBatchForIntent: vi.fn(async (_intentId: string, jobs: OutboundJob[]) => {
        captured.push(jobs);
        return { enqueued: true, jobCount: jobs.length };
      }),
      markOutboxIntentCompleted: vi.fn().mockResolvedValue(undefined),
      markOutboxIntentEventLogPublished: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn().mockResolvedValue(undefined),
      enqueueOutboxIntent: vi.fn().mockResolvedValue("retry"),
      moveToDlq: vi.fn().mockResolvedValue(undefined),
    } as any;
    const worker = new TestIntentWorker(queue, null, intentWorkerConfig());

    await worker.run("msg-a", intent("sidecar-random-a"));
    await worker.run("msg-b", intent("sidecar-random-b"));

    expect(captured).toHaveLength(2);
    expect(captured[0]).toHaveLength(1);
    expect(captured[1]).toHaveLength(1);
    expect(captured[0]?.[0]?.jobId).toBe(
      "https://pods.example/alice/activities/1::https://remote.example/inbox",
    );
    expect(captured[1]?.[0]?.jobId).toBe(captured[0]?.[0]?.jobId);
    expect(captured[0]?.[0]?.meta).toEqual(
      expect.objectContaining({ deliveryPlanIntentId: "apdm-v1-stable-plan-id" }),
    );
  });

  it("expires a stale durable outbox intent before it can create outbound replay work", async () => {
    const queue = {
      getOutboxIntentState: vi.fn().mockResolvedValue({}),
      enqueueOutboundBatchForIntent: vi.fn().mockResolvedValue({ enqueued: true, jobCount: 1 }),
      markOutboxIntentCompleted: vi.fn().mockResolvedValue(undefined),
      markOutboxIntentEventLogPublished: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn().mockResolvedValue(undefined),
      enqueueOutboxIntent: vi.fn().mockResolvedValue("retry"),
      moveToDlq: vi.fn().mockResolvedValue(undefined),
    } as any;
    const worker = new TestIntentWorker(queue, null, intentWorkerConfig());
    const stale = intent("stale-sidecar-intent");
    stale.createdAt = Date.now() - APDM_OUTBOX_INTENT_MAX_AGE_MS - 1;

    await worker.run("stale-intent", stale);

    expect(queue.enqueueOutboundBatchForIntent).not.toHaveBeenCalled();
    expect(queue.moveToDlq).toHaveBeenCalledWith(
      "outbox_intent",
      expect.objectContaining({ intentId: stale.intentId }),
      expect.stringContaining("replay residence limit"),
    );
    expect(queue.ack).toHaveBeenCalledWith("outbox_intent", "stale-intent");
  });

  it("does not mistake a dead worker's in-flight claim for completed delivery", async () => {
    const queue = createOutboundQueue();
    const claimStore = new StatefulClaimStore();
    const job = outboundJob();
    claimStore.seedInFlight(job.jobId);
    const worker = new TestOutboundWorker(
      queue,
      {} as any,
      {} as any,
      outboundWorkerConfig(claimStore),
    );

    await worker.run("reclaimed-while-claim-live", job);

    expect(worker.deliveries).toBe(0);
    expect(claimStore.isCompleted(job.jobId)).toBe(false);
    expect(queue.enqueueOutbound).toHaveBeenCalledTimes(1);
    expect(queue.ack).toHaveBeenCalledWith("outbound", "reclaimed-while-claim-live");

    claimStore.expireInFlight(job.jobId);
    await worker.run("reclaimed-after-claim-expiry", { ...job, notBeforeMs: 0 });

    expect(worker.deliveries).toBe(1);
    expect(claimStore.isCompleted(job.jobId)).toBe(true);
    expect(queue.ack).toHaveBeenCalledWith("outbound", "reclaimed-after-claim-expiry");
  });

  it("suppresses a duplicate only after completed-delivery state is durable", async () => {
    const queue = createOutboundQueue();
    const claimStore = new StatefulClaimStore();
    const job = outboundJob();
    const worker = new TestOutboundWorker(
      queue,
      {} as any,
      {} as any,
      outboundWorkerConfig(claimStore),
    );

    await worker.run("outbound-a", job);
    await worker.run("outbound-b", { ...job });

    expect(worker.deliveries).toBe(1);
    expect(claimStore.isCompleted(job.jobId)).toBe(true);
    expect(queue.ack).toHaveBeenCalledWith("outbound", "outbound-a");
    expect(queue.ack).toHaveBeenCalledWith("outbound", "outbound-b");
    expect(queue.enqueueOutbound).not.toHaveBeenCalled();
  });

  it("expires an outbound message that sat in Redis too long before its first claim check", async () => {
    const queue = createOutboundQueue();
    const claimStore = new StatefulClaimStore();
    const job = outboundJob();
    const worker = new TestOutboundWorker(
      queue,
      {} as any,
      {} as any,
      outboundWorkerConfig(claimStore),
    );
    const staleEnqueueMs = Date.now() - APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS - 1;
    const staleRedisMessageId = `${staleEnqueueMs}-0`;

    await worker.run(staleRedisMessageId, job);

    expect(worker.deliveries).toBe(0);
    expect(claimStore.claimCalls).toBe(0);
    expect(queue.moveToDlq).toHaveBeenCalledWith(
      "outbound",
      expect.objectContaining({ jobId: job.jobId }),
      expect.stringContaining("queue residence limit"),
    );
    expect(queue.ack).toHaveBeenCalledWith("outbound", staleRedisMessageId);
  });
});
