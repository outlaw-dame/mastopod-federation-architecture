import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { RedisStreamsQueue, type InboundEnvelope, type OutboundJob, type OutboxIntent } from "../src/queue/sidecar-redis-queue-core.js";
import { RedisOutboxIntentDelayScheduler } from "../src/delivery/outbox-intent-delay-scheduler.js";
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
 assert((await redis.xLen(keys.outbound))===2,"Fanout kept too many entries");
 await expectCapacity(()=>queue.enqueueOutboundBatchForIntent("overflow-"+prefix,[job(6),job(7)]),
   "Fanout exceeded capacity");
 assert((await redis.xLen(keys.outbound))===2,"Rejected fanout partially enqueued");

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
  const promoted=await scheduler.promoteDue(Date.now());
  assert(promoted===1,"Due intent was not retried after capacity returned");
  assert((await redis.zScore(keys.delayed,due.intentId))===null,
   "Promoted delayed job remains scheduled");
 } finally {await scheduler.stop().catch(()=>undefined);}
 await queue.moveToDlq("inbound",message(11),"first");
 await queue.moveToDlq("inbound",message(12),"second");
 await expectCapacity(()=>queue.moveToDlq("inbound",message(13),"overflow"),
  "DLQ discarded unreviewed work");
 assert((await redis.xLen(keys.dlq))===2,"DLQ capacity exceeded");

 console.log("REDIS_ACKED_QUEUE_ADMISSION_PROOF "+JSON.stringify({
  mode:"opt-in-redis-8.2-acked",
  version:(await redis.info("server")).match(/^redis_version:([^\r\n]+)/m)?.[1]??"unknown",
  pendingJobSurvivedPressure:true,unreadJobSurvivedPressure:true,
  producerBackpressure:true,ackedWorkReclaimed:true,
  fanoutCapacity:true,delayedPromotionPreservesWork:true,
  dlqRetainsUnreviewedEntries:true,elapsedMs:Date.now()-started,
 }));
} finally {
 await queue.disconnect().catch(()=>undefined);
 if(redis.isOpen){
  await redis.del(Object.values(keys)).catch(()=>undefined);
  await redis.quit().catch(()=>redis.disconnect());
 }
}
