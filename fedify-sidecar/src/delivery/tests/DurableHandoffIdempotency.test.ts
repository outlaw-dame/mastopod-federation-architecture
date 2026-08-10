vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { OutboxIntentWorker, type OutboxIntentWorkerConfig } from "../outbox-intent-worker.js";
import { OutboundWorker, type DeliveryResult, type OutboundWorkerConfig } from "../outbound-worker.js";
import type { OutboxIntent, OutboundJob } from "../../queue/sidecar-redis-queue.js";
import { DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY } from "../../protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";

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

function outboundWorkerConfig(): OutboundWorkerConfig {
  return {
    concurrency: 1,
    maxConcurrentPerDomain: 2,
    requestTimeoutMs: 1000,
    userAgent: "apdm-test",
    fedifyRuntimeIntegrationEnabled: false,
  };
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

  it("duplicate outbound jobs are acknowledged without a second remote delivery", async () => {
    const queue = {
      checkIdempotency: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      isDomainBlocked: vi.fn().mockResolvedValue(false),
      checkDomainRateLimit: vi.fn().mockResolvedValue(true),
      acquireDomainSlot: vi.fn().mockResolvedValue(true),
      releaseDomainSlot: vi.fn().mockResolvedValue(undefined),
      clearIdempotency: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn().mockResolvedValue(undefined),
      moveToDlq: vi.fn().mockResolvedValue(undefined),
      enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    } as any;
    const signingClient = {} as any;
    const redpanda = {} as any;
    const worker = new TestOutboundWorker(queue, signingClient, redpanda, outboundWorkerConfig());
    const job: OutboundJob = {
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

    await worker.run("outbound-a", job);
    await worker.run("outbound-b", { ...job });

    expect(queue.checkIdempotency).toHaveBeenCalledTimes(2);
    expect(worker.deliveries).toBe(1);
    expect(queue.ack).toHaveBeenCalledWith("outbound", "outbound-a");
    expect(queue.ack).toHaveBeenCalledWith("outbound", "outbound-b");
  });
});
