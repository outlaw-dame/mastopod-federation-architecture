import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const noop=()=>undefined;
  const logger={info:noop,warn:noop,error:noop,debug:noop};
  return { logger, default:logger };
});
vi.mock("undici",()=>({request:vi.fn()}));

import { InboundWorker } from "../inbound-worker.js";
import {
  OriginReconciliationWorker,
  type OriginReconciliationWorkerConfig,
} from "../origin-reconciliation-worker.js";
import type {
  InboundEnvelope, OriginReconciliationJob,
} from "../../queue/sidecar-redis-queue.js";

class TestInbound extends InboundWorker {
  async run(messageId:string,envelope:InboundEnvelope) {
    return this.processEnvelope(messageId,envelope);
  }
}
class TestOrigin extends OriginReconciliationWorker {
  async run(messageId:string,job:OriginReconciliationJob) {
    return this.processJob(messageId,job);
  }
}

const original:InboundEnvelope={
  envelopeId:"capacity-envelope",method:"POST",path:"/inbox",
  headers:{},body:"{malformed-json",remoteIp:"127.0.0.1",
  receivedAt:Date.now(),attempt:0,notBeforeMs:0,
};
const blocked:OriginReconciliationJob={
  jobId:"blocked-reconcile",originObjectUrl:"http://127.0.0.1/private",
  canonicalObjectId:"http://127.0.0.1/private",
  actorUriHint:"https://remote.example/users/alice",
  reason:"conversation-hydration",createdAt:Date.now()-1000,
  attempt:0,maxAttempts:3,notBeforeMs:0,
  windowExpiresAt:Date.now()+600000,lastFingerprint:"",
  unchangedSuccesses:0,notFoundCount:0,
};

const inbound=(queue:any)=>new TestInbound(queue, {
  publishToStream1:vi.fn(),publishToStream2:vi.fn(),publishTombstone:vi.fn(),
} as any, {
  concurrency:1,activityPodsUrl:"http://localhost:3000",
  activityPodsToken:"token",requestTimeoutMs:5000,
  userAgent:"capacity-proof",fedifyRuntimeIntegrationEnabled:false,
} as any);
function originQueue(overrides:Record<string,unknown>={}) {
  return {
    ack:vi.fn().mockResolvedValue(undefined),
    enqueueOriginReconciliation:vi.fn().mockResolvedValue("new-id"),
    enqueueInbound:vi.fn().mockResolvedValue(undefined),
    moveToDlq:vi.fn().mockResolvedValue(undefined),
    checkDomainRateLimit:vi.fn().mockResolvedValue(true),
    acquireDomainSlot:vi.fn().mockResolvedValue(true),
    releaseDomainSlot:vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}
const config:OriginReconciliationWorkerConfig={
  concurrency:1,signerActorUri:"https://local.example/users/relay",
  requestTimeoutMs:1000,requestRetries:0,
  requestRetryBaseDelayMs:100,requestRetryMaxDelayMs:500,
  userAgent:"capacity-proof",perOriginConcurrency:2,
  perOriginBurstLimit:4,perOriginBurstWindowSeconds:60,
  maxUnchangedSuccesses:2,applyIdempotencyTtlSeconds:300,
};
const signing:any={signOne:vi.fn().mockResolvedValue({ok:true,signedHeaders:{}})};

describe("ack after durable Redis replacement",()=>{
  it("does not ACK an inbound source when its DLQ is full",async()=>{
    const queue={
      ack:vi.fn().mockResolvedValue(undefined),
      moveToDlq:vi.fn().mockRejectedValue(Error("REDIS_STREAM_AT_CAPACITY")),
    } as any;
    await inbound(queue).run("in-1",original);
    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    expect(queue.ack).not.toHaveBeenCalled();
  });

  it("ACKs only after DLQ persists an invalid inbound message",async()=>{
    const calls:string[]=[];
    const queue={
      ack:vi.fn(async()=>{calls.push("ack");}),
      moveToDlq:vi.fn(async()=>{calls.push("dlq");}),
    } as any;
    await inbound(queue).run("in-2",original);
    expect(calls).toEqual(["dlq","ack"]);
  });

  it("retains a deferred origin source if its replacement enqueue is rejected",async()=>{
    const queue=originQueue({
      enqueueOriginReconciliation:vi.fn().mockRejectedValue(
        Error("REDIS_STREAM_AT_CAPACITY")),
    });
    const worker=new TestOrigin(queue,signing,config);
    await expect(worker.run("origin-1",{
      ...blocked,originObjectUrl:"https://remote.example/objects/1",
      notBeforeMs:Date.now()+100000,
    })).rejects.toThrow(/REDIS_STREAM_AT_CAPACITY/);
    expect(queue.enqueueOriginReconciliation).toHaveBeenCalledTimes(1);
    expect(queue.ack).not.toHaveBeenCalled();
  });

  it("retains an origin source if the dead-letter destination is full",async()=>{
    const queue=originQueue({
      moveToDlq:vi.fn().mockRejectedValue(
        Error("REDIS_STREAM_AT_CAPACITY")),
    });
    const worker=new TestOrigin(queue,signing,config);
    await expect(worker.run("origin-2",blocked))
      .rejects.toThrow(/REDIS_STREAM_AT_CAPACITY/);
    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    expect(queue.ack).not.toHaveBeenCalled();
  });
});
