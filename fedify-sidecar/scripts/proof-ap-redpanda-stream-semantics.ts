import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Kafka, logLevel } from "kafkajs";
import { createRedPandaProducer } from "../src/streams/redpanda-producer.js";

const brokers = (process.env["REDPANDA_BROKERS"] || "127.0.0.1:19092")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const stream1Topic = process.env["STREAM1_TOPIC"] || "ap.stream1.local-public.v1";
const stream2Topic = process.env["STREAM2_TOPIC"] || "ap.stream2.remote-public.v1";
const firehoseTopic = process.env["FIREHOSE_TOPIC"] || "ap.firehose.v1";
const tombstoneTopic = process.env["TOMBSTONE_TOPIC"] || "ap.tombstones.v1";
const outputPath = process.env["AP_REDPANDA_STREAM_PROOF_OUTPUT"] || "ap-redpanda-stream-proof.json";

if (brokers.length === 0) {
  throw new Error("REDPANDA_BROKERS must contain at least one broker");
}

const proofId = `ap-stream-proof-${randomUUID()}`;
const localActivityId = `urn:${proofId}:local`;
const remoteActivityId = `urn:${proofId}:remote`;
const tombstoneActivityId = `urn:${proofId}:tombstone`;
const tombstoneObjectId = `urn:${proofId}:deleted-object`;

const producer = createRedPandaProducer({
  brokers,
  clientId: `${proofId}-producer`,
  stream1Topic,
  stream2Topic,
  firehoseTopic,
  tombstoneTopic,
});

await producer.connect();
try {
  await producer.publishToStream1({
    activity: {
      id: localActivityId,
      type: "Create",
      actor: "https://local.example/users/alice",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: `urn:${proofId}:local-note`,
        type: "Note",
        content: "local proof event",
      },
    },
    actorUri: "https://local.example/users/alice",
    publishedAt: Date.now(),
    origin: "local",
    outboxIntentId: `${proofId}:intent`,
  });

  await producer.publishToStream2({
    activity: {
      id: remoteActivityId,
      type: "Create",
      actor: "https://remote.example/users/bob",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: `urn:${proofId}:remote-note`,
        type: "Note",
        content: "remote proof event",
      },
    },
    actorUri: "https://remote.example/users/bob",
    receivedAt: Date.now(),
    origin: "remote",
    delivery: {
      forwarding: "attempted",
      recipientCount: 1,
      localRecipientCount: 1,
    },
  });

  await producer.publishTombstone({
    activityId: tombstoneActivityId,
    objectId: tombstoneObjectId,
    actorUri: "https://local.example/users/alice",
    deletedAt: Date.now(),
  });
} finally {
  await producer.disconnect();
}

const kafka = new Kafka({
  clientId: `${proofId}-consumer`,
  brokers,
  logLevel: logLevel.WARN,
  retry: { initialRetryTime: 100, retries: 8 },
});
const consumer = kafka.consumer({ groupId: `${proofId}-group` });
await consumer.connect();

for (const topic of [stream1Topic, stream2Topic, firehoseTopic, tombstoneTopic]) {
  await consumer.subscribe({ topic, fromBeginning: true });
}

const observed = new Map<string, string[]>();
for (const topic of [stream1Topic, stream2Topic, firehoseTopic, tombstoneTopic]) {
  observed.set(topic, []);
}

function recordIfProofEvent(topic: string, raw: string): void {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const activityId = parsed?.activity?.id;
  if (activityId === localActivityId || activityId === remoteActivityId) {
    observed.get(topic)?.push(activityId);
    return;
  }

  if (parsed?.activityId === tombstoneActivityId && parsed?.objectId === tombstoneObjectId) {
    observed.get(topic)?.push(tombstoneActivityId);
  }
}

await consumer.run({
  eachMessage: async ({ topic, message }) => {
    if (!message.value) return;
    recordIfProofEvent(topic, message.value.toString("utf8"));
  },
});

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  const stream1 = observed.get(stream1Topic) ?? [];
  const stream2 = observed.get(stream2Topic) ?? [];
  const firehose = observed.get(firehoseTopic) ?? [];
  const tombstones = observed.get(tombstoneTopic) ?? [];

  if (
    stream1.includes(localActivityId) &&
    stream2.includes(remoteActivityId) &&
    firehose.includes(localActivityId) &&
    firehose.includes(remoteActivityId) &&
    tombstones.includes(tombstoneActivityId)
  ) {
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}

await consumer.disconnect();

const stream1Observed = observed.get(stream1Topic) ?? [];
const stream2Observed = observed.get(stream2Topic) ?? [];
const firehoseObserved = observed.get(firehoseTopic) ?? [];
const tombstoneObserved = observed.get(tombstoneTopic) ?? [];

const assertions = {
  stream1ContainsOnlyLocalProof: JSON.stringify(stream1Observed) === JSON.stringify([localActivityId]),
  stream2ContainsOnlyRemoteProof: JSON.stringify(stream2Observed) === JSON.stringify([remoteActivityId]),
  firehoseContainsLocalExactlyOnce: firehoseObserved.filter(id => id === localActivityId).length === 1,
  firehoseContainsRemoteExactlyOnce: firehoseObserved.filter(id => id === remoteActivityId).length === 1,
  firehoseExcludesTombstoneProof: !firehoseObserved.includes(tombstoneActivityId),
  stream1ExcludesRemoteProof: !stream1Observed.includes(remoteActivityId),
  stream2ExcludesLocalProof: !stream2Observed.includes(localActivityId),
  tombstoneTopicContainsOnlyTombstoneProof: JSON.stringify(tombstoneObserved) === JSON.stringify([tombstoneActivityId]),
};

const ok = Object.values(assertions).every(Boolean);
const evidence = {
  version: 1,
  proofId,
  brokers,
  topics: {
    stream1: stream1Topic,
    stream2: stream2Topic,
    firehose: firehoseTopic,
    tombstones: tombstoneTopic,
  },
  expected: {
    stream1: [localActivityId],
    stream2: [remoteActivityId],
    firehose: [localActivityId, remoteActivityId],
    tombstones: [tombstoneActivityId],
  },
  observed: {
    stream1: stream1Observed,
    stream2: stream2Observed,
    firehose: firehoseObserved,
    tombstones: tombstoneObserved,
  },
  assertions,
  ok,
};

await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

if (!ok) {
  process.exitCode = 1;
}
