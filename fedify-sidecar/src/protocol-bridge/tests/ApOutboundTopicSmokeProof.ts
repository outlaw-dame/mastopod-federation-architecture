import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { Kafka, logLevel } from "kafkajs";
import { RedpandaEventPublisher } from "../../core-domain/events/RedpandaEventPublisher.js";
import { EventPublisherActivityPubPort } from "../adapters/EventPublisherActivityPubPort.js";

const execFile = promisify(execFileCb);
const broker = process.env["SMOKE_KAFKA_BROKER"] || "localhost:9092";
const topic = process.env["SMOKE_OUTBOUND_TOPIC"] || `ap.outbound.smoke.${randomUUID().slice(0, 8)}`;
const timeoutMs = Number(process.env["SMOKE_TIMEOUT_MS"] || 15000);
const redpandaContainer = process.env["SMOKE_REDPANDA_CONTAINER"] || "redpanda";

async function ensureTopic(kafka: Kafka, topicName: string): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    if (!existing.includes(topicName)) {
      await admin.createTopics({
        topics: [{ topic: topicName, numPartitions: 1, replicationFactor: 1 }],
        waitForLeaders: true,
      });
    }
  } finally {
    await admin.disconnect();
  }
}

async function readOutboundMessageViaRpk(topicName: string): Promise<any> {
  const { stdout } = await execFile(
    "docker",
    [
      "exec",
      redpandaContainer,
      "rpk",
      "topic",
      "consume",
      topicName,
      "-n",
      "1",
      "--offset",
      "start",
      "--format",
      "json",
    ],
    { timeout: timeoutMs },
  );

  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`No output returned from rpk consume for ${topicName}`);
  }

  const envelope = JSON.parse(raw);
  if (!envelope?.value || typeof envelope.value !== "string") {
    throw new Error(`rpk consume returned malformed envelope for ${topicName}`);
  }

  return JSON.parse(envelope.value);
}

function assertOutboundEnvelope(payload: any): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("Outbound payload is not an object");
  }

  const requiredTopLevel = ["jobId", "actor", "targetDomain", "recipients", "activity", "bridge", "timestamp"];
  for (const key of requiredTopLevel) {
    if (!(key in payload)) {
      throw new Error(`Outbound payload missing required field: ${key}`);
    }
  }

  if (!Array.isArray(payload.recipients) || payload.recipients.length === 0) {
    throw new Error("Outbound payload has empty recipients");
  }

  if (typeof payload.activity?.type !== "string") {
    throw new Error("Outbound payload missing activity.type");
  }

  if (typeof payload.bridge?.canonicalIntentId !== "string") {
    throw new Error("Outbound payload missing bridge.canonicalIntentId");
  }
}

async function main(): Promise<void> {
  const kafka = new Kafka({
    clientId: `smoke-client-${randomUUID()}`,
    brokers: [broker],
    logLevel: logLevel.NOTHING,
  });

  await ensureTopic(kafka, topic);

  const publisher = new RedpandaEventPublisher({
    brokers: [broker],
    clientId: `smoke-publisher-${randomUUID()}`,
    compression: "none",
  });

  const bridgePort = new EventPublisherActivityPubPort(publisher, {
    outboundResolver: {
      resolve: async () => [
        {
          actor: "https://example.com/users/alice",
          targetDomain: "example.net",
          recipients: ["https://example.net/inbox"],
          sharedInbox: null as any,
        },
      ],
    },
  });

  const apOutboxCommittedFixture = {
    schema: "ap.outbox.committed.v1",
    activity: {
      id: `https://example.com/activities/${randomUUID()}`,
      type: "Create",
      actor: "https://example.com/users/alice",
      object: {
        type: "Note",
        id: `https://example.com/notes/${randomUUID()}`,
        attributedTo: "https://example.com/users/alice",
        content: "containerized outbound smoke",
      },
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      published: new Date().toISOString(),
    },
  };

  await bridgePort.publish([
    {
      kind: "publishActivity",
      targetTopic: topic as "ap.outbound.v1",
      activity: apOutboxCommittedFixture.activity,
      metadata: {
        canonicalIntentId: `intent-${randomUUID()}`,
        sourceProtocol: "activitypub",
        provenance: {
          originProtocol: "activitypub",
          originEventId: apOutboxCommittedFixture.activity.id,
          mirroredFromCanonicalIntentId: null,
          projectionMode: "native",
        },
      },
    },
  ] as any);

  const payload = await readOutboundMessageViaRpk(topic);
  assertOutboundEnvelope(payload);

  console.log(
    JSON.stringify(
      {
        ok: true,
        broker,
        topic,
        actor: payload.actor,
        targetDomain: payload.targetDomain,
        recipients: payload.recipients,
        activityType: payload.activity?.type,
        canonicalIntentId: payload.bridge?.canonicalIntentId,
      },
      null,
      2,
    ),
  );

  await publisher.disconnect();
}

main().catch((err) => {
  console.error("[ap-outbound-smoke] failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
