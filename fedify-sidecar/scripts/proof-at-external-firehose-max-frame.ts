/**
 * Disposable real-Redpanda proof of large external Sync raw-event delivery.
 * Synthetic frame bytes exercise byte budgets; they are not signed commits.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Kafka, logLevel } from "kafkajs";
import { RedpandaEventPublisher } from "../src/core-domain/events/RedpandaEventPublisher.js";
import {
  AT_SYNC_MAX_FRAME_BYTES,
  AT_SYNC_RAW_MAX_EVENT_BYTES,
  AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES,
  AT_SYNC_RAW_FETCH_BYTES_PER_PARTITION,
  AT_SYNC_RAW_FETCH_BYTES,
} from "../src/at-adapter/ingress/AtExternalFirehosePayloadLimits.js";

const id = randomUUID().replaceAll("-", "");
const topic = "at.firehose.raw.proof-" + id.slice(0, 12) + ".v1";
const brokers = (process.env["REDPANDA_BROKERS"] || "127.0.0.1:19092")
  .split(",").map(x => x.trim()).filter(Boolean);
if (!brokers.length) throw new Error("No Redpanda proof brokers");
const kafka = new Kafka({
  brokers,clientId:"sync-size-proof-"+id.slice(0,12),
  logLevel:logLevel.WARN,
  connectionTimeout:10000,requestTimeout:20000,
  retry:{initialRetryTime:100,retries:4},
});
const admin = kafka.admin();
let publisher: RedpandaEventPublisher | null = null;
const consumer = kafka.consumer({
  groupId:"sync-size-proof-"+id,
  allowAutoTopicCreation:false,
  maxBytesPerPartition:AT_SYNC_RAW_FETCH_BYTES_PER_PARTITION,
  maxBytes:AT_SYNC_RAW_FETCH_BYTES,
});
const bytes = randomBytes(AT_SYNC_MAX_FRAME_BYTES);
const encoded = bytes.toString("base64");
const expectedHash = createHash("sha256").update(bytes).digest("hex");
const proof = {
  seq: 1,
  source:"wss://relay.example.test/xrpc/com.atproto.sync.subscribeRepos",
  did:"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  eventType:"#commit",
  receivedAt:new Date().toISOString(),
  rawCborBase64:encoded,
};
const started = Date.now();
let responseLength = 0;
let responseHash = "";
let actualConfig = "";
try {
  await admin.connect();
  await admin.createTopics({
    waitForLeaders:true,
    topics:[{
      topic,numPartitions:1,replicationFactor:1,
      configEntries:[{
        name:"max.message.bytes",
        value:String(AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES),
      }],
    }],
  });
  const configs = await admin.describeConfigs({
    resources:[{type:2,name:topic,configNames:["max.message.bytes"]}],
    includeSynonyms:false,
  });
  actualConfig = configs.resources[0]?.configEntries?.find(
    x => x.configName === "max.message.bytes")?.configValue ?? "";
  if (Number(actualConfig) < AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES) {
    throw Error("Raw broker topic maximum is lower than the configured source limit");
  }
  publisher = new RedpandaEventPublisher({
    brokers,clientId:"sync-size-publisher-"+id.slice(0,12),
    compression:"none",largeRawFirehoseTopic:topic,
  });
  await publisher.publish(topic,proof as any);
  await consumer.connect();
  await consumer.subscribe({topic,fromBeginning:true});
  let onMessage: ((value:void)=>void)|null = null;
  const received = new Promise<void>(resolve=>{onMessage=resolve;});
  await consumer.run({eachMessage:async ({message})=>{
    if(!message.value)return;
    const incoming=JSON.parse(message.value.toString("utf8")) as typeof proof;
    responseLength=Buffer.byteLength(message.value);
    responseHash=createHash("sha256")
      .update(Buffer.from(incoming.rawCborBase64,"base64")).digest("hex");
    onMessage?.();
  }});
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      received,
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(Error("Raw broker event fetch timed out")),20000);
      }),
    ]);
  } finally {if(timer)clearTimeout(timer);}
  if(responseHash!==expectedHash)throw Error("Raw frame digest mismatched after Redpanda roundtrip");
  if(responseLength>=AT_SYNC_RAW_MAX_EVENT_BYTES)throw Error("Raw serialization exceeded 8 MiB budget");
  if(responseLength<6*1024*1024)throw Error("Proof frame did not exercise the large payload path");
  const evidence={
    test:"disposable-real-redpanda-sync-raw-frame",
    brokerTopic:topic,
    topicMaxMessageBytes:Number(actualConfig),
    syntheticFrameBytes:bytes.length,
    receivedMessageBytes:responseLength,
    digestVerified:true,roundtripMs:Date.now()-started,
    note:"Synthetic CBOR-sized bytes; signed commit verification and production throughput not tested",
  };
  const output=process.env["AT_SYNC_LARGE_FRAME_PROOF_OUTPUT"] ||
    "../measurements/redpanda-ap-streams/sync-large-raw-proof.json";
  await writeFile(output,JSON.stringify(evidence,null,2)+"\n","utf8");
  console.log("SYNC_LARGE_RAW_PROOF "+JSON.stringify(evidence));
} finally {
  await consumer.stop().catch(()=>undefined);
  await consumer.disconnect().catch(()=>undefined);
  await publisher?.disconnect().catch(()=>undefined);
  await admin.disconnect().catch(()=>undefined);
}
