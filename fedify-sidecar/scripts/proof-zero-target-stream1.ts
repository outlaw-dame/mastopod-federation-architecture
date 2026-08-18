import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import Redis from "ioredis";
import { Kafka, logLevel } from "kafkajs";

const sidecarUrl = process.env["ZERO_TARGET_SIDECAR_URL"] ?? "http://127.0.0.1:8080";
const sidecarToken = process.env["SIDECAR_TOKEN"];
const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const outboundStreamKey = process.env["OUTBOUND_STREAM_KEY"] ?? "ap:queue:outbound:v1";
const brokers = (process.env["REDPANDA_BROKERS"] ?? "127.0.0.1:19092")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
const stream1Topic = process.env["STREAM1_TOPIC"] ?? "ap.stream1.local-public.v1";
const firehoseTopic = process.env["FIREHOSE_TOPIC"] ?? "ap.firehose.v1";
const outputPath = process.env["ZERO_TARGET_STREAM1_PROOF_OUTPUT"] ?? "zero-target-stream1-proof.json";

if (!sidecarToken) throw new Error("SIDECAR_TOKEN is required");
if (brokers.length === 0) throw new Error("REDPANDA_BROKERS must contain at least one broker");

const proofId = `zero-target-${randomUUID()}`;
const intentId = `apdm-v1-${proofId}`;
const activityId = `urn:${proofId}:activity`;
const actorUri = `https://local.example/users/${proofId}`;
const createdAt = new Date().toISOString();

const redis = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});
await redis.connect();
const outboundLengthBefore = await redis.xlen(outboundStreamKey);

const response = await fetch(`${sidecarUrl.replace(/\/$/u, "")}/webhook/outbox`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${sidecarToken}`,
    "content-type": "application/json",
    "x-apdm-intent-id": intentId,
  },
  body: JSON.stringify({
    actorUri,
    activityId,
    activity: {
      id: activityId,
      type: "Create",
      actor: actorUri,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: `urn:${proofId}:note`,
        type: "Note",
        content: "ADSP zero-target local public Stream1 proof",
        published: createdAt,
      },
    },
    remoteTargets: [],
    meta: {
      visibility: "public",
      isPublicActivity: true,
      isPublicIndexable: true,
      deliveryPlanIntentId: intentId,
      deliveryPlanSchema: "ap.delivery-plan.v1",
    },
  }),
});

const acknowledgementText = await response.text();
let acknowledgement: unknown;
try {
  acknowledgement = acknowledgementText.length > 0 ? JSON.parse(acknowledgementText) : null;
} catch {
  acknowledgement = acknowledgementText;
}

if (response.status !== 202) {
  throw new Error(`zero-target durable handoff returned ${response.status}: ${acknowledgementText}`);
}
if (
  !acknowledgement ||
  typeof acknowledgement !== "object" ||
  Array.isArray(acknowledgement) ||
  (acknowledgement as Record<string, unknown>)["accepted"] !== true
) {
  throw new Error("zero-target durable handoff did not return accepted=true");
}

const kafka = new Kafka({
  clientId: `${proofId}-consumer`,
  brokers,
  logLevel: logLevel.WARN,
  retry: { initialRetryTime: 100, retries: 8 },
});
const consumer = kafka.consumer({ groupId: `${proofId}-group` });
await consumer.connect();
await consumer.subscribe({ topic: stream1Topic, fromBeginning: true });
await consumer.subscribe({ topic: firehoseTopic, fromBeginning: true });

const observed = new Map<string, number>([
  [stream1Topic, 0],
  [firehoseTopic, 0],
]);

await consumer.run({
  eachMessage: async ({ topic, message }) => {
    if (!message.value) return;
    let parsed: any;
    try {
      parsed = JSON.parse(message.value.toString("utf8"));
    } catch {
      return;
    }
    if (parsed?.activity?.id !== activityId) return;
    if (parsed?.outboxIntentId !== intentId) {
      throw new Error(`matching activity carried unexpected outboxIntentId on ${topic}`);
    }
    observed.set(topic, (observed.get(topic) ?? 0) + 1);
  },
});

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  if ((observed.get(stream1Topic) ?? 0) >= 1 && (observed.get(firehoseTopic) ?? 0) >= 1) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}

await consumer.disconnect();

// Give any accidentally-created outbound job enough time to become observable.
await new Promise(resolve => setTimeout(resolve, 500));
const outboundLengthAfter = await redis.xlen(outboundStreamKey);
await redis.quit();

const assertions = {
  acceptedDurably: response.status === 202,
  stream1ExactlyOnceInHealthyRun: (observed.get(stream1Topic) ?? 0) === 1,
  firehoseExactlyOnceInHealthyRun: (observed.get(firehoseTopic) ?? 0) === 1,
  noOutboundJobCreated: outboundLengthAfter === outboundLengthBefore,
};
const ok = Object.values(assertions).every(Boolean);
const evidence = {
  version: 1,
  proofId,
  intentId,
  activityId,
  topics: { stream1: stream1Topic, firehose: firehoseTopic },
  acknowledgement,
  observed: {
    stream1Count: observed.get(stream1Topic) ?? 0,
    firehoseCount: observed.get(firehoseTopic) ?? 0,
  },
  outboundStream: {
    key: outboundStreamKey,
    before: outboundLengthBefore,
    after: outboundLengthAfter,
  },
  assertions,
  ok,
};

await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (!ok) process.exitCode = 1;
