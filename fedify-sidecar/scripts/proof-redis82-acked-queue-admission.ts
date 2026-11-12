import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { RedisStreamsQueue, type InboundEnvelope, type OutboundJob, type OutboxIntent } from "../src/queue/sidecar-redis-queue-core.js";
import { RedisOutboxIntentDelayScheduler } from "../src/delivery/outbox-intent-delay-scheduler.js";
import { RedisStreamsQueue as DurableRedisStreamsQueue } from "../src/queue/sidecar-redis-queue.js";
import {
 appendAcknowledgedStreamBatch, requireRedis82AckedSupport,
} from "../src/queue/redis-stream-safe-admission.js";

const url=process.env["REDIS_URL"]||"redis://127.0.0.1:6379";
const redis=createClient({url});
redis.on("error",e=>console.error("Disposable Redis proof",e.message));
const prefix="proof:acked:"+randomUUID().replaceAll("-","");
const group="proof-workers";
const keys={
 inbound:prefix+":inbound",outbound:prefix+":outbound",
 multigroup:prefix+":multigroup",concurrent:prefix+":concurrent",
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
 // ACKED must wait for every consumer group, not just the first ACK.
 await redis.xGroupCreate(keys.multigroup,"proof-a","0",{MKSTREAM:true});
 await redis.xGroupCreate(keys.multigroup,"proof-b","0");
 await appendAcknowledgedStreamBatch(redis,keys.multigroup,[{kind:"shared"}],1);
 const firstGroupRead=await redis.xReadGroup("proof-a","consumer-a",
   {key:keys.multigroup,id:">"},{COUNT:1});
 const sharedId=firstGroupRead?.[0]?.messages?.[0]?.id;
 assert(sharedId,"First consumer group did not receive shared work");
 await redis.xAck(keys.multigroup,"proof-a",sharedId);
 await expectCapacity(()=>appendAcknowledgedStreamBatch(
   redis,keys.multigroup,[{kind:"replacement"}],1),
   "One group's ACK removed work unread by a second group");
 const secondGroupRead=await redis.xReadGroup("proof-b","consumer-b",
   {key:keys.multigroup,id:">"},{COUNT:1});
 assert(secondGroupRead?.[0]?.messages?.[0]?.id===sharedId,
   "Second group lost the original work before acknowledging it");
 await redis.xAck(keys.multigroup,"proof-b",sharedId);
 await appendAcknowledgedStreamBatch(redis,keys.multigroup,
   [{kind:"replacement"}],1);
 const surviving=await redis.xRange(keys.multigroup,"-","+");
 assert(surviving.length===1 && surviving[0]?.message["kind"]==="replacement",
   "Fully acknowledged cross-group work was not safely reclaimed");

 // Lua admission is serialized by Redis: simultaneous producers must never
 // overfill the queue or report success for a rejected append.
 await redis.xGroupCreate(keys.concurrent,group,"0",{MKSTREAM:true});
 const burst=await Promise.allSettled(Array.from({length:20},(_,i)=>
   appendAcknowledgedStreamBatch(redis,keys.concurrent,
     [{producer:String(i)}],3)));
 const accepted=burst.filter(result=>result.status==="fulfilled").length;
 assert(accepted===3,"Concurrent producer admission exceeded its hard cap");
 assert(burst.every(result=>result.status==="fulfilled" ||
   String(result.reason).includes("REDIS_STREAM_AT_CAPACITY")),
   "Concurrent admission returned an unexpected failure");
 const burstRecords=await redis.xRange(keys.concurrent,"-","+");
 assert(burstRecords.length===3 &&
   new Set(burstRecords.map(record=>record.message["producer"])).size===3,
   "Concurrent admission lost, duplicated or overfilled accepted work");

 const withoutGroup=prefix+":ungrouped";
 await redis.xAdd(withoutGroup,"*",{kind:"unread"});
 let rejectedMissingGroup=false;
 try {
  await appendAcknowledgedStreamBatch(
   redis,withoutGroup,[{kind:"another"}],2);
 } catch(error) {
  rejectedMissingGroup=String(error).includes("REDIS_STREAM_NO_CONSUMER_GROUP");
 }
 assert(rejectedMissingGroup,
   "ACKED trimming without any consumer group must be rejected");
 assert((await redis.xLen(withoutGroup))===1,
   "Missing-group rejection deleted unread work");
 await redis.del(withoutGroup);

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

  // A malformed optional field must be quarantined before an XADD error
  // could occur after earlier valid work has already been appended.
  const readyIntent=intent(11),malformedIntent=intent(12);
  const overdue=Date.now()-100;
  readyIntent.notBeforeMs=overdue;
  malformedIntent.notBeforeMs=overdue;
  await redis.zAdd(keys.delayed,[
   {score:overdue,value:readyIntent.intentId},
   {score:overdue,value:malformedIntent.intentId},
  ]);
  await redis.hSet(keys.payload,readyIntent.intentId,JSON.stringify(readyIntent));
  await redis.hSet(keys.payload,malformedIntent.intentId,
   JSON.stringify({...malformedIntent,lastError:{invalid:"object"}}));
  assert(await scheduler.promoteDue(Date.now())===1,
   "Malformed delayed intent blocked valid work or was appended");
  const acceptedIntents=await redis.xRange(keys.intent,"-","+");
  assert(acceptedIntents.length===3 &&
   acceptedIntents.some(entry=>entry.message["intentId"]===readyIntent.intentId) &&
   !acceptedIntents.some(entry=>entry.message["intentId"]===malformedIntent.intentId),
   "Malformed delayed intent was written to ready stream or healthy intent was lost");
  assert((await redis.xLen(keys.dlq))===1,
   "Malformed delayed intent was not quarantined");
  assert((await redis.zScore(keys.delayed,malformedIntent.intentId))===null,
   "Quarantined delayed intent remained scheduled");
  // Reset this disposable proof DLQ for the separate hard-cap assertions.
  await redis.del(keys.dlq);
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

  // Two orphaned schedule IDs do not consume ready-stream capacity. Without
  // counting payload-backed entries separately, the previous #ids preflight
  // could reject this batch forever even though there is one free slot.
  const staleIds=[prefix+":stale-a",prefix+":stale-b"];
  await redis.zAdd(schedule,staleIds.map(value=>({score:Date.now()-100,value})));
  const valid=job(103);
  valid.notBeforeMs=Date.now()-10;
  await redis.hSet(delayedOutbound+":delayed-payload:v1",
    valid.jobId,JSON.stringify(valid));
  await redis.zAdd(schedule,{score:Date.now()-100,value:valid.jobId});
  assert(await wrapper.promoteDueOutbound(Date.now())===1,
    "Stale schedule IDs incorrectly consumed ready-stream capacity");
  for(const id of staleIds)assert((await redis.zScore(schedule,id))===null,
    "Stale delayed schedule record was not cleaned up");
  assert((await redis.xLen(delayedOutbound))===2,
    "Stale due entries caused incorrect ready-stream accounting");

  // Lua errors do not roll back preceding writes. A corrupt later payload
  // must be detected before trimming or appending an earlier valid job.
  const allReady=await redis.xReadGroup(group,"wrapper-proof",
    {key:delayedOutbound,id:">"},{COUNT:10});
  const allIds=allReady?.[0]?.messages?.map(m=>m.id)??[];
  assert(allIds.length===2,"Expected two ready entries before malformed batch");
  await redis.xAck(delayedOutbound,group,allIds);
  const first=job(104),bad=job(105);
  first.notBeforeMs=Date.now()-10;
  const dueAt=Date.now()-100;
  const payloadKey=delayedOutbound+":delayed-payload:v1";
  await redis.hSet(payloadKey,first.jobId,JSON.stringify(first));
  await redis.hSet(payloadKey,bad.jobId,JSON.stringify({jobId:bad.jobId}));
  await redis.zAdd(schedule,[
    {score:dueAt,value:first.jobId},{score:dueAt,value:bad.jobId},
  ]);
  let rejectedInvalid=false;
  try{await wrapper.promoteDueOutbound(Date.now());}
  catch(error){
    rejectedInvalid=String(error).includes("invalid delayed outbound payload");
    if(!rejectedInvalid)throw error;
  }
  assert(rejectedInvalid,"Malformed due work was not rejected before writes");
  assert((await redis.xLen(delayedOutbound))===2,
    "Malformed batch mutated the ready stream before failing");
  assert((await redis.zScore(schedule,first.jobId))!==null &&
    (await redis.zScore(schedule,bad.jobId))!==null,
    "Malformed batch removed scheduled work before validation");
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
  missingGroupRejected:true,multigroupAckBarrier:true,
  concurrentAdmissionBound:true,
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
