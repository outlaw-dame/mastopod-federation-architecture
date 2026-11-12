import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { RedisStreamsQueue, type InboundEnvelope, type OutboundJob, type OutboxIntent } from "../src/queue/sidecar-redis-queue-core.js";
import { RedisOutboxIntentDelayScheduler } from "../src/delivery/outbox-intent-delay-scheduler.js";
import { RedisStreamsQueue as DurableRedisStreamsQueue } from "../src/queue/sidecar-redis-queue.js";
import { requireRedis82AckedSupport } from "../src/queue/redis-stream-safe-admission.js";

const url=process.env["REDIS_URL"]||"redis://127.0.0.1:6379";
const redis=createClient({url});
redis.on("error",e=>console.error("Disposable Redis proof",e.message));
const prefix="proof:acked:"+randomUUID().replaceAll("-","");
const group="proof-workers";
const keys={
 inbound:prefix+":inbound",outbound:prefix+":outbound",
 intent:prefix+":intent",origin:prefix+":origin",dlq:prefix+":dlq",
 delayed:prefix+":intent:delayed:v1",payload:prefix+":intent:delayed-payload:v1",
};
const queue=new RedisStreamsQueue({
 redisUrl:url,consumerGroup:group,consumerId:"proof-consumer",
 inboundStreamKey:keys.inbound,outboundStreamKey:keys.outbound,
 outboxIntentStreamKey:keys.intent,originReconcileStreamKey:keys.origin,
 inboundDlqStreamKey:keys.dlq,outboundDlqStreamKey:keys.dlq,
 outboxIntentDlqStreamKey:keys.dlq,originReconcileDlqStreamKey:keys.dlq,
 maxStreamLength:3,maxDlqLength:2,safeAckedRetention:true,
});
const message=(n:number):InboundEnvelope=>({
 envelopeId:"message-"+n,method:"POST",path:"/inbox",
 headers:{},body:'{"type":"Create"}',remoteIp:"127.0.0.1",
 receivedAt:Date.now(),attempt:0,notBeforeMs:0,
});
const job=(n:number):OutboundJob=>({
 jobId:"job-"+n,activityId:"act-"+n,actorUri:"https://actor.example/test",
 activity:'{"type":"Create"}',targetInbox:"https://remote.example/inbox",
 targetDomain:"remote.example",attempt:0,maxAttempts:5,notBeforeMs:0,
});
const intent=(n:number):OutboxIntent=>({
 intentId:"intent-"+n,activityId:"act-"+n,actorUri:"https://actor.example/test",
 activity:'{"type":"Create"}',targets:[],createdAt:Date.now(),
 attempt:0,maxAttempts:5,notBeforeMs:0,
});
function assert(value:unknown,why:string):asserts value {if(!value)throw Error(why);}
async function expectCapacity(task:()=>Promise<unknown>,why:string) {
 let rejected=false;
 try{await task();}
 catch(e){if(String(e).includes("REDIS_STREAM_AT_CAPACITY"))rejected=true;else throw e;}
 assert(rejected,why);
}
async function readAndAck(stream:string) {
 const batch=await redis.xReadGroup(group,"proof-consumer",
  {key:stream,id:">"},{COUNT:100});
 const ids=batch?.[0]?.messages?.map(m=>m.id)??[];
 if(ids.length)await redis.xAck(stream,group,ids);
 return ids;
}
const started=Date.now();
try {
 await redis.connect();
 await requireRedis82AckedSupport(redis);
 await queue.connect();
 for(let i=1;i<=3;i++)await queue.enqueueInbound(message(i));
 const claimed=await redis.xReadGroup(group,"proof-consumer",
  {key:keys.inbound,id:">"},{COUNT:1});
 const pendingId=claimed?.[0]?.messages?.[0]?.id;
 assert(pendingId,"Expected pending inbound message");
 await expectCapacity(()=>queue.enqueueInbound(message(4)),
   "Inbound admission deleted pending or unread work");
 assert((await redis.xRange(keys.inbound,pendingId,pendingId)).length===1,
   "Pending inbound entry was trimmed");
 assert((await redis.xLen(keys.inbound))===3,"Inbound queue exceeded capacity");
 await redis.xAck(keys.inbound,group,pendingId);
 await queue.enqueueInbound(message(4));
 assert((await redis.xLen(keys.inbound))===3,"ACKED did not reclaim acknowledged work");

 await queue.enqueueOutboundBatch([job(1),job(2),job(3)]);
 await expectCapacity(()=>queue.enqueueOutboundBatch([job(4)]),
   "Outbound queue exceeded capacity");
 assert((await redis.xLen(keys.outbound))===3,"Rejected outbound batch changed length");
 const outbound=await readAndAck(keys.outbound);
 assert(outbound.length===3,"Outbound work not delivered");
 const fanout=await queue.enqueueOutboundBatchForIntent("fanout-"+prefix,[job(4),job(5)]);
 assert(fanout.enqueued&&fanout.jobCount===2,"Fanout ACKED reclamation failed");
 assert((await redis.xLen(keys.outbound))===3,"Fanout did not preserve its bounded retention reserve");
 await expectCapacity(()=>queue.enqueueOutboundBatchForIntent("overflow-"+prefix,[job(6),job(7)]),
   "Fanout exceeded capacity");
 const retained=await redis.xRange(keys.outbound,"-","+");
 assert(retained.length<=3,"Rejected fanout exceeded bounded capacity");
 assert(!retained.some(entry=>["job-6","job-7"].includes(entry.message["jobId"])),
   "Rejected fanout wrote partial new jobs");
 assert(retained.some(entry=>entry.message["jobId"]==="job-4") &&
   retained.some(entry=>entry.message["jobId"]==="job-5"),
   "Rejected fanout discarded unacknowledged work");

 for(let i=1;i<=3;i++)await queue.enqueueOutboxIntent(intent(i));
 const scheduler=new RedisOutboxIntentDelayScheduler({
  redisUrl:url,readyStreamKey:keys.intent,dlqStreamKey:keys.dlq,
  consumerGroup:group,maxStreamLength:3,maxDlqLength:2,
  promotionIntervalMs:60000,promotionBatchSize:10,safeAckedRetention:true,
 });
 const due=intent(10);
 due.notBeforeMs=Date.now()-10;
 await redis.zAdd(keys.delayed,{score:Date.now()-10,value:due.intentId});
 await redis.hSet(keys.payload,due.intentId,JSON.stringify(due));
 try {
  await expectCapacity(()=>scheduler.start(),"Due promotion discarded unread work");
  assert((await redis.zScore(keys.delayed,due.intentId))!==null,
   "Blocked due intent was removed from schedule");
  const ready=await readAndAck(keys.intent);
  assert(ready.length===3,"Could not acknowledge ready intents");
  // Failed admission deliberately closed the standalone scheduler client.
  // Retrying startup must re-open it and promote the retained delayed source.
  await scheduler.start();
  assert((await redis.zScore(keys.delayed,due.intentId))===null,
   "Promoted delayed job remains scheduled");
 } finally {await scheduler.stop().catch(()=>undefined);}
 await queue.moveToDlq("inbound",message(11),"first");
 await queue.moveToDlq("inbound",message(12),"second");
 await expectCapacity(()=>queue.moveToDlq("inbound",message(13),"overflow"),
  "DLQ discarded unreviewed work");
 assert((await redis.xLen(keys.dlq))===2,"DLQ capacity exceeded");

 // The outbound delayed wrapper has its own Lua promotion path and must
 // obey the same cap as the core stream writers.
 const previousNodeEnv=process.env["NODE_ENV"];
 const previousCutover=process.env["APDM_COMPLETION_MARKER_V2_CUTOVER"];
 // This script owns a disposable Redis instance with no legacy APDM markers.
 process.env["NODE_ENV"]="production";
 process.env["APDM_COMPLETION_MARKER_V2_CUTOVER"]="fresh";
 const delayedOutbound=prefix+":delayed-outbound";
 const wrapper=new DurableRedisStreamsQueue({
  redisUrl:url,consumerGroup:group,consumerId:"wrapper-proof",
  inboundStreamKey:prefix+":wrapper-in",outboundStreamKey:delayedOutbound,
  outboxIntentStreamKey:prefix+":wrapper-intent",
  originReconcileStreamKey:prefix+":wrapper-origin",
  inboundDlqStreamKey:prefix+":wrapper-in-dlq",
  outboundDlqStreamKey:prefix+":wrapper-out-dlq",
  outboxIntentDlqStreamKey:prefix+":wrapper-intent-dlq",
  originReconcileDlqStreamKey:prefix+":wrapper-origin-dlq",
  maxStreamLength:2,maxDlqLength:2,safeAckedRetention:true,
 });
 try {
  await wrapper.connect();
  const delayedJob=job(100);
  delayedJob.notBeforeMs=Date.now()+30_000;
  await wrapper.enqueueOutboundBatch([delayedJob]);
  await wrapper.enqueueOutboundBatch([job(101),job(102)]);
  const schedule=delayedOutbound+":delayed:v1";
  await redis.zAdd(schedule,{score:Date.now()-100,value:delayedJob.jobId});
  await expectCapacity(()=>wrapper.promoteDueOutbound(Date.now()),
    "Delayed outbound promotion discarded unread ready work");
  assert((await redis.zScore(schedule,delayedJob.jobId))!==null,
    "Rejected outbound promotion lost its delayed source");
  const readyBatch=await redis.xReadGroup(group,"wrapper-proof",
    {key:delayedOutbound,id:">"},{COUNT:10});
  const readyIds=readyBatch?.[0]?.messages?.map(m=>m.id)??[];
  assert(readyIds.length===2,"Delayed outbound setup did not fill ready queue");
  await redis.xAck(delayedOutbound,group,readyIds);
  assert(await wrapper.promoteDueOutbound(Date.now())===1,
    "Delayed outbound work did not resume after ACKED reclaim");
  assert((await redis.zScore(schedule,delayedJob.jobId))===null,
    "Successfully promoted outbound work stayed in delayed schedule");
 } finally {
  await wrapper.disconnect().catch(()=>undefined);
  process.env["NODE_ENV"]=previousNodeEnv;
  if(previousCutover===undefined)delete process.env["APDM_COMPLETION_MARKER_V2_CUTOVER"];
  else process.env["APDM_COMPLETION_MARKER_V2_CUTOVER"]=previousCutover;
  await redis.del([
    delayedOutbound,delayedOutbound+":delayed:v1",
    delayedOutbound+":delayed-payload:v1",prefix+":wrapper-in",
    prefix+":wrapper-intent",prefix+":wrapper-origin",
    prefix+":wrapper-in-dlq",prefix+":wrapper-out-dlq",
    prefix+":wrapper-intent-dlq",prefix+":wrapper-origin-dlq",
  ]).catch(()=>undefined);
 }

 console.log("REDIS_ACKED_QUEUE_ADMISSION_PROOF "+JSON.stringify({
  mode:"opt-in-redis-8.2-acked",
  version:(await redis.info("server")).match(/^redis_version:([^\r\n]+)/m)?.[1]??"unknown",
  pendingJobSurvivedPressure:true,unreadJobSurvivedPressure:true,
  producerBackpressure:true,ackedWorkReclaimed:true,
  fanoutCapacity:true,delayedPromotionPreservesWork:true,
  dlqRetainsUnreviewedEntries:true,delayedOutboundPromotionPreservesWork:true,
  elapsedMs:Date.now()-started,
 }));
} finally {
 await queue.disconnect().catch(()=>undefined);
 if(redis.isOpen){
  await redis.del(Object.values(keys)).catch(()=>undefined);
  await redis.quit().catch(()=>redis.disconnect());
 }
}
