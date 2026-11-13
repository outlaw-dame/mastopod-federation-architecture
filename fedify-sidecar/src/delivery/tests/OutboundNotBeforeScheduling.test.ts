vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import {
  MAX_INLINE_NOT_BEFORE_WAIT_MS,
  OutboundWorker,
  type DeliveryResult,
  type OutboundWorkerConfig,
} from "../outbound-worker.js";
import type { OutboundJob } from "../../queue/sidecar-redis-queue.js";
import type {
  DeliveryClaimResult,
  OutboundDeliveryClaimStore,
} from "../outbound-delivery-claims.js";

class ClaimStore implements OutboundDeliveryClaimStore {
  claimCalls = 0;

  async claim(): Promise<DeliveryClaimResult> {
    this.claimCalls += 1;
    return "claimed";
  }

  async complete(): Promise<void> {}
  async release(): Promise<void> {}
  async close(): Promise<void> {}
}

class TestWorker extends OutboundWorker {
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

function queue() {
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

function config(claimStore: OutboundDeliveryClaimStore): OutboundWorkerConfig {
  return {
    concurrency: 1,
    maxConcurrentPerDomain: 1,
    requestTimeoutMs: 1_000,
    userAgent: "not-before-test",
    fedifyRuntimeIntegrationEnabled: false,
    deliveryClaimStore: claimStore,
    deliveryClaimTtlMs: 1_000,
    deliveryCompletedTtlMs: 60_000,
    notReadyMinDelayMs: 1,
    notReadyJitterMs: 0,
  };
}

function job(notBeforeMs: number): OutboundJob {
  return {
    jobId: "https://pods.example/alice/activities/1::https://remote.example/inbox",
    activityId: "https://pods.example/alice/activities/1",
    actorUri: "https://pods.example/alice",
    activity: JSON.stringify({ type: "Create" }),
    targetInbox: "https://remote.example/inbox",
    targetDomain: "remote.example",
    attempt: 0,
    maxAttempts: 10,
    notBeforeMs,
    deferCount: 7,
  };
}

class BackpressuredRetryWorker extends OutboundWorker {
  async run(messageId:string, job:OutboundJob):Promise<void> {
    return this.processJob(messageId,job);
  }
  protected override async deliver(job:OutboundJob):Promise<DeliveryResult> {
    return { jobId:job.jobId, success:false, permanent:false,
      statusCode:503, error:"Remote server unavailable" };
  }
}

describe("outbound not-before scheduling", () => {
  it("does not DLQ or ACK an outbound message when Redis cannot accept its retry",async()=>{
    const q=queue();
    q.enqueueOutbound.mockRejectedValue(Error("REDIS_STREAM_AT_CAPACITY"));
    const claims=new ClaimStore();
    const worker=new BackpressuredRetryWorker(q,{} as any,{} as any,config(claims));
    const durableJob=job(0);
    durableJob.meta={apdmFirstQueuedAtMs:Date.now()-500};
    await worker.run("pending-outbound",durableJob);
    expect(q.enqueueOutbound).toHaveBeenCalled();
    expect(q.ack).not.toHaveBeenCalled();
    expect(q.moveToDlq).not.toHaveBeenCalled();
  });

  it("waits briefly on the original Stream entry without consuming the deferral budget", async () => {
    const q = queue();
    const claims = new ClaimStore();
    const worker = new TestWorker(q, {} as any, {} as any, config(claims));
    const future = job(Date.now() + 20);

    await worker.run("msg-1", future);

    expect(worker.deliveries).toBe(1);
    expect(claims.claimCalls).toBe(1);
    expect(q.enqueueOutbound).not.toHaveBeenCalled();
    expect(q.moveToDlq).not.toHaveBeenCalled();
    expect(q.ack).toHaveBeenCalledWith("outbound", "msg-1");
  });

  it("leaves long-delay work pending for XAUTOCLAIM instead of hot-requeueing it", async () => {
    const q = queue();
    const claims = new ClaimStore();
    const worker = new TestWorker(q, {} as any, {} as any, config(claims));
    const future = job(Date.now() + MAX_INLINE_NOT_BEFORE_WAIT_MS + 10_000);

    await worker.run("msg-2", future);

    expect(worker.deliveries).toBe(0);
    expect(claims.claimCalls).toBe(0);
    expect(q.enqueueOutbound).not.toHaveBeenCalled();
    expect(q.moveToDlq).not.toHaveBeenCalled();
    expect(q.ack).not.toHaveBeenCalled();
  });
});
