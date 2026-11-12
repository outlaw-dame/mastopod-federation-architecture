/**
 * Disposable Redis 7 vs 8.2+ Streams retention proof.
 * Establishes whether MAXLEN deletes pending or undelivered work, and whether
 * ACKED preserves it. This is an acceptance fixture, NOT a production switch.
 */
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const client=createClient({url:process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379"});
client.on("error",err=>console.error("Disposable Redis proof error",err.message));
const mode=process.env["REDIS_STREAM_ACKED_PROOF_MODE"];
if(mode!=="legacy"&&mode!=="acked")throw Error("Set REDIS_STREAM_ACKED_PROOF_MODE to legacy or acked");
const key="proof:redis:stream-retention:"+randomUUID();
const group="proof-workers";
try {
  await client.connect();
  const info=await client.info("server");
  const version=info.match(/^redis_version:([0-9]+)\.([0-9]+)\.([0-9]+)/m);
  if(!version)throw Error("Redis server did not report a version");
  const major=Number(version[1]),minor=Number(version[2]);
  if(mode==="acked"&&(major<8||(major===8&&minor<2)))throw Error("ACKED requires Redis >=8.2");
  if(mode==="legacy"&&major>=8)throw Error("Legacy proof expected Redis 7");
  const firstId=await client.xAdd(key,"*",{kind:"pending",value:"first"});
  await client.xGroupCreate(key,group,"0");
  const claimed=await client.xReadGroup(group,"consumer-1",{key,id:">"},{COUNT:1});
  if(!claimed?.[0]?.messages?.length)throw Error("Could not create pending first message");
  const afterFirst=await client.xPending(key,group);
  if(afterFirst.pending!==1)throw Error("Expected one pending stream message");

  let neverDeliveredId="";
  for(let i=1;i<=256;i++){
    const args=["XADD",key,...(mode==="acked"?["ACKED"]:[]),
      "MAXLEN","~","10","*","kind","queued","index",String(i)];
    const id=await client.sendCommand(args);
    if(i===1)neverDeliveredId=String(id);
  }

  const pendingStillPresent=(await client.xRange(key,firstId,firstId)).length===1;
  const neverDeliveredStillPresent=(await client.xRange(key,neverDeliveredId,neverDeliveredId)).length===1;
  const p=await client.xPending(key,group);
  const beforeAckLength=await client.xLen(key);
  if(mode==="acked"&&(!pendingStillPresent||!neverDeliveredStillPresent)){
    throw Error("ACKED mode removed unacknowledged or never-delivered work");
  }
  if(mode==="legacy"&&(pendingStillPresent||neverDeliveredStillPresent)){
    throw Error("Legacy fixture did not reproduce early MAXLEN removal");
  }
  if(p.pending!==1)throw Error("Unexpected pending-entry count");
  let trimmedAfterAcknowledgment:number|null=null;
  if(mode==="acked"){
    const remaining=await client.xReadGroup(
      group,"consumer-1",{key,id:">"},{COUNT:512});
    const ids=(remaining?.[0]?.messages ?? []).map(x=>x.id);
    await client.xAck(key,group,[firstId,...ids]);
    const trimmed=await client.sendCommand(["XTRIM",key,"MAXLEN","~","10","ACKED"]);
    trimmedAfterAcknowledgment=Number(trimmed);
    const after=await client.xPending(key,group);
    if(after.pending!==0)throw Error("ACKED retained pending entries after acknowledgment");
    if((await client.xLen(key))>=beforeAckLength)throw Error("ACKED trimming did not reclaim acknowledged records");
  }
  const evidence={
    version:version[0].slice("redis_version:".length),
    mode,inserted:257,maxLenTarget:10,
    pendingStillPresent,neverDeliveredStillPresent,
    pendingCountAfterPressure:p.pending,
    lengthAfterPressure:beforeAckLength,
    trimmedAfterAcknowledgment,
    conclusion:mode==="legacy"?"Legacy MAXLEN can remove pending/unread jobs":
      "ACKED retains unread/pending work but needs bounded producer admission",
  };
  console.log("REDIS_STREAM_RETENTION_PROOF "+JSON.stringify(evidence));
  if(process.env["REDIS_STREAM_TRIM_PROOF_OUTPUT"]){
    await writeFile(process.env["REDIS_STREAM_TRIM_PROOF_OUTPUT"]!,
      JSON.stringify(evidence,null,2)+"\n","utf8");
  }
} finally {
  if(client.isOpen){
    await client.del(key).catch(()=>undefined);
    await client.quit().catch(()=>client.disconnect());
  }
}
