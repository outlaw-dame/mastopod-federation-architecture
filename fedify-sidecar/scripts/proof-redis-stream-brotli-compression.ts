import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createClient } from "redis";
import { RedisStreamPayloadCodec } from "../src/queue/redis-stream-payload-codec.js";

const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const outputPath = process.env["REDIS_BROTLI_PROOF_OUTPUT"];
const prefix = `ap:proof:brotli:${process.pid}:${Date.now()}`;

const cases = [
  { activityBytes: 20 * 1024, recipients: 10_000, endpoints: 10 },
  { activityBytes: 20 * 1024, recipients: 10_000, endpoints: 100 },
  { activityBytes: 100 * 1024, recipients: 10_000, endpoints: 10 },
  { activityBytes: 100 * 1024, recipients: 10_000, endpoints: 100 },
  { activityBytes: 100 * 1024, recipients: 1_000, endpoints: 1_000 },
] as const;

function deterministicText(targetBytes: number): string {
  let out = "";
  let index = 0;
  while (Buffer.byteLength(out) < targetBytes) {
    const digest = createHash("sha256").update(String(index)).digest("hex").slice(0, 12);
    out += `activitypub-${digest} federation-${index % 17} `;
    index += 1;
  }
  return out.slice(0, targetBytes);
}

function makeActivity(targetBytes: number): string {
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://local.example/activities/brotli-proof",
    type: "Create",
    actor: "https://local.example/users/alice",
    object: {
      id: "https://local.example/objects/brotli-proof",
      type: "Note",
      content: "",
    },
  };
  const skeletonBytes = Buffer.byteLength(JSON.stringify(activity));
  activity.object.content = deterministicText(Math.max(0, targetBytes - skeletonBytes));
  return JSON.stringify(activity);
}

function makeTargets(recipients: number, endpoints: number): string {
  return JSON.stringify(Array.from({ length: recipients }, (_, index) => {
    const endpoint = index % endpoints;
    const domain = `server-${endpoint}.example`;
    return {
      inboxUrl: `https://${domain}/users/user-${index}/inbox`,
      sharedInboxUrl: endpoints < recipients ? `https://${domain}/inbox` : undefined,
      deliveryUrl: endpoints < recipients
        ? `https://${domain}/inbox`
        : `https://${domain}/users/user-${index}/inbox`,
      targetDomain: domain,
    };
  }));
}

function commonOutboundFields(index: number, activity: string): Record<string, string> {
  return {
    jobId: `job-${index}`,
    activityId: "https://local.example/activities/brotli-proof",
    actorUri: "https://local.example/users/alice",
    activity,
    targetInbox: `https://server-${index}.example/inbox`,
    targetDomain: `server-${index}.example`,
    attempt: "0",
    maxAttempts: "10",
    notBeforeMs: "0",
    deferCount: "0",
    lastError: "",
    meta: "",
  };
}

async function memoryUsage(client: ReturnType<typeof createClient>, key: string): Promise<number> {
  const value = await client.sendCommand(["MEMORY", "USAGE", key, "SAMPLES", "0"]);
  return value == null ? 0 : Number(value);
}

async function writeVariant(input: {
  client: ReturnType<typeof createClient>;
  caseId: string;
  name: string;
  activity: string;
  targets: string;
  endpoints: number;
  codec: RedisStreamPayloadCodec;
}) {
  const { client, caseId, name, activity, targets, endpoints, codec } = input;
  const outboxKey = `${prefix}:${caseId}:${name}:outbox`;
  const outboundKey = `${prefix}:${caseId}:${name}:outbound`;

  const encodeStart = performance.now();
  const encodedActivity = codec.encode(activity);
  const encodedTargets = codec.encode(targets);
  const encodeMs = performance.now() - encodeStart;

  if (codec.decode(encodedActivity.value) !== activity) throw new Error("Activity round-trip mismatch");
  if (codec.decode(encodedTargets.value) !== targets) throw new Error("Target round-trip mismatch");

  const writeStart = performance.now();
  await client.xAdd(outboxKey, "*", {
    intentId: "intent-1",
    activityId: "https://local.example/activities/brotli-proof",
    actorUri: "https://local.example/users/alice",
    activity: encodedActivity.value,
    targets: encodedTargets.value,
    createdAt: "1",
    attempt: "0",
    maxAttempts: "8",
    notBeforeMs: "0",
    lastError: "",
    meta: "",
    bridgeHints: "",
  });

  const chunkSize = 250;
  for (let offset = 0; offset < endpoints; offset += chunkSize) {
    const multi = client.multi();
    for (let index = offset; index < Math.min(endpoints, offset + chunkSize); index += 1) {
      multi.xAdd(outboundKey, "*", commonOutboundFields(index, encodedActivity.value));
    }
    await multi.exec();
  }
  const writeMs = performance.now() - writeStart;

  const redisBytes = await memoryUsage(client, outboxKey) + await memoryUsage(client, outboundKey);
  await client.del([outboxKey, outboundKey]);

  return {
    name,
    activityCompressed: encodedActivity.compressed,
    targetsCompressed: encodedTargets.compressed,
    activityStoredBytes: encodedActivity.storedBytes,
    targetsStoredBytes: encodedTargets.storedBytes,
    encodeMs,
    writeMs,
    redisBytes,
  };
}

async function main() {
  const client = createClient({ url: redisUrl });
  await client.connect();
  try {
    const plaintextCodec = new RedisStreamPayloadCodec({ writeEnabled: false });
    const brotliCodec = new RedisStreamPayloadCodec({ writeEnabled: true, minBytes: 4096, brotliQuality: 1 });
    const results = [];

    for (const testCase of cases) {
      const activity = makeActivity(testCase.activityBytes);
      const targets = makeTargets(testCase.recipients, testCase.endpoints);
      const caseId = `a${testCase.activityBytes}-r${testCase.recipients}-e${testCase.endpoints}`;
      const current = await writeVariant({
        client,
        caseId,
        name: "plaintext",
        activity,
        targets,
        endpoints: testCase.endpoints,
        codec: plaintextCodec,
      });
      const compressed = await writeVariant({
        client,
        caseId,
        name: "brotli-1",
        activity,
        targets,
        endpoints: testCase.endpoints,
        codec: brotliCodec,
      });
      results.push({
        ...testCase,
        actualActivityBytes: Buffer.byteLength(activity),
        targetBytes: Buffer.byteLength(targets),
        current,
        compressed,
        redisReduction: current.redisBytes / Math.max(1, compressed.redisBytes),
      });
    }

    const minimumReduction = Math.min(...results.map(result => result.redisReduction));
    if (minimumReduction < 1.5) {
      throw new Error(`Brotli production-envelope proof missed 1.5x minimum memory reduction: ${minimumReduction}`);
    }

    const output = {
      schema: "apdm-redis-stream-brotli-proof.v1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      minimumReduction,
      results,
      interpretation: {
        encodeMs: "single Activity + target-vector encode cost per intent; Activity encoding is reused for endpoint writes",
        writeMs: "bounded equivalent Stream write timing, not full ActivityPub delivery latency",
        promotion: "memory eligibility only; default enablement still requires queue/worker latency and CPU guardrails",
      },
    };

    const rendered = `${JSON.stringify(output, null, 2)}\n`;
    if (outputPath) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, rendered);
    }
    process.stdout.write(rendered);
  } finally {
    await client.quit();
  }
}

await main();
