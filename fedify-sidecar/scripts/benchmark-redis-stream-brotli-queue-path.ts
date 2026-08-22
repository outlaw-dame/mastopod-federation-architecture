import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createClient } from "redis";
import {
  RedisStreamsQueue,
  type OutboundJob,
  type OutboxIntent,
  type OutboxIntentTarget,
} from "../src/queue/sidecar-redis-queue-core.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const OUTPUT_PATH = process.env["REDIS_BROTLI_QUEUE_BENCHMARK_OUTPUT"];

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer; received ${raw}`);
  }
  return value;
}

const MEASURED_SAMPLES = positiveIntegerEnv("REDIS_BROTLI_QUEUE_BENCHMARK_SAMPLES", 5);
const WARMUP_SAMPLES = positiveIntegerEnv("REDIS_BROTLI_QUEUE_BENCHMARK_WARMUPS", 1);

const CASES = [
  { name: "medium-high-collapse", activityBytes: 20 * 1024, recipients: 10_000, endpoints: 10 },
  { name: "large-moderate-collapse", activityBytes: 100 * 1024, recipients: 10_000, endpoints: 100 },
  { name: "large-high-endpoint", activityBytes: 100 * 1024, recipients: 1_000, endpoints: 1_000 },
] as const;

type Arm = "plaintext" | "brotli";

type Sample = {
  elapsedMs: number;
  cpuMicros: number;
  intentBytes: number;
  outboundBytes: number;
  completedOutbound: number;
};

function deterministicText(targetBytes: number): string {
  let output = "";
  let index = 0;
  while (Buffer.byteLength(output) < targetBytes) {
    const token = createHash("sha256").update(`queue-${index}`).digest("hex").slice(0, 12);
    output += `activitypub-${token} federation-${index % 23} `;
    index += 1;
  }
  return output.slice(0, targetBytes);
}

function makeActivity(targetBytes: number): string {
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://local.example/activities/queue-benchmark",
    type: "Create",
    actor: "https://local.example/users/alice",
    object: {
      id: "https://local.example/objects/queue-benchmark",
      type: "Note",
      content: "",
    },
  };
  const skeletonBytes = Buffer.byteLength(JSON.stringify(activity));
  activity.object.content = deterministicText(Math.max(0, targetBytes - skeletonBytes));
  return JSON.stringify(activity);
}

function makeTargets(recipients: number, endpoints: number): OutboxIntentTarget[] {
  return Array.from({ length: recipients }, (_, index) => {
    const endpoint = index % endpoints;
    const domain = `server-${endpoint}.example`;
    const shared = endpoints < recipients ? `https://${domain}/inbox` : undefined;
    return {
      inboxUrl: `https://${domain}/users/user-${index}/inbox`,
      ...(shared ? { sharedInboxUrl: shared } : {}),
      deliveryUrl: shared ?? `https://${domain}/users/user-${index}/inbox`,
      targetDomain: domain,
    };
  });
}

function makeJobs(activity: string, endpoints: number, suffix: string): OutboundJob[] {
  return Array.from({ length: endpoints }, (_, index) => ({
    jobId: `job-${suffix}-${index}`,
    activityId: "https://local.example/activities/queue-benchmark",
    actorUri: "https://local.example/users/alice",
    activity,
    targetInbox: `https://server-${index}.example/inbox`,
    targetDomain: `server-${index}.example`,
    attempt: 0,
    maxAttempts: 10,
    notBeforeMs: 0,
  }));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
}

function summarize(samples: Sample[]) {
  const elapsed = samples.map(sample => sample.elapsedMs);
  const cpu = samples.map(sample => sample.cpuMicros);
  return {
    samples: samples.length,
    elapsedMs: {
      p50: percentile(elapsed, 0.5),
      p95: percentile(elapsed, 0.95),
      p99: percentile(elapsed, 0.99),
    },
    cpuMicros: {
      p50: percentile(cpu, 0.5),
      p95: percentile(cpu, 0.95),
      p99: percentile(cpu, 0.99),
    },
    intentBytes: samples[0]?.intentBytes ?? 0,
    outboundBytes: samples[0]?.outboundBytes ?? 0,
    completedOutbound: samples[0]?.completedOutbound ?? 0,
  };
}

async function streamMemory(client: ReturnType<typeof createClient>, key: string): Promise<number> {
  const value = await client.sendCommand(["MEMORY", "USAGE", key, "SAMPLES", "0"]);
  return value == null ? 0 : Number(value);
}

async function runSample(input: {
  arm: Arm;
  testCase: typeof CASES[number];
  sampleIndex: number;
  queue: RedisStreamsQueue;
  admin: ReturnType<typeof createClient>;
  intentStream: string;
  outboundStream: string;
  activity: string;
  targets: OutboxIntentTarget[];
}): Promise<Sample> {
  const { arm, testCase, sampleIndex, queue, admin, intentStream, outboundStream, activity, targets } = input;
  const suffix = `${arm}-${testCase.name}-${sampleIndex}-${Date.now()}`;
  const intent: OutboxIntent = {
    intentId: `intent-${suffix}`,
    activityId: "https://local.example/activities/queue-benchmark",
    actorUri: "https://local.example/users/alice",
    activity,
    targets,
    createdAt: Date.now(),
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
  };
  const jobs = makeJobs(activity, testCase.endpoints, suffix);

  const cpuStart = process.cpuUsage();
  const start = performance.now();

  await queue.enqueueOutboxIntent(intent);
  const fanout = await queue.enqueueOutboundBatchForIntent(intent.intentId, jobs);
  if (!fanout.enqueued || fanout.jobCount !== jobs.length) {
    throw new Error(`Unexpected fanout result for ${suffix}: ${JSON.stringify(fanout)}`);
  }

  const intentIterator = queue.consumeOutboxIntents()[Symbol.asyncIterator]();
  const intentEntry = await intentIterator.next();
  if (intentEntry.done || intentEntry.value.intent.intentId !== intent.intentId) {
    throw new Error(`Did not consume expected intent ${intent.intentId}`);
  }
  if (intentEntry.value.intent.activity !== activity || intentEntry.value.intent.targets.length !== targets.length) {
    throw new Error(`Outbox intent round-trip mismatch for ${suffix}`);
  }
  await queue.ack("outbox_intent", intentEntry.value.messageId);
  await intentIterator.return?.();

  const outboundIterator = queue.consumeOutbound()[Symbol.asyncIterator]();
  let completedOutbound = 0;
  while (completedOutbound < jobs.length) {
    const entry = await outboundIterator.next();
    if (entry.done) throw new Error(`Outbound iterator ended early for ${suffix}`);
    if (entry.value.job.activity !== activity) {
      throw new Error(`Outbound Activity round-trip mismatch for ${suffix}`);
    }
    await queue.ack("outbound", entry.value.messageId);
    completedOutbound += 1;
  }
  await outboundIterator.return?.();

  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMicros = cpu.user + cpu.system;
  const intentBytes = await streamMemory(admin, intentStream);
  const outboundBytes = await streamMemory(admin, outboundStream);

  return { elapsedMs, cpuMicros, intentBytes, outboundBytes, completedOutbound };
}

async function createArmQueue(caseName: string, arm: Arm) {
  const token = `${process.pid}-${Date.now()}-${caseName}-${arm}`;
  const intentStream = `ap:bench:brotli-queue:${token}:intent`;
  const outboundStream = `ap:bench:brotli-queue:${token}:outbound`;
  const queue = new RedisStreamsQueue({
    redisUrl: REDIS_URL,
    outboxIntentStreamKey: intentStream,
    outboundStreamKey: outboundStream,
    inboundStreamKey: `ap:bench:brotli-queue:${token}:inbound`,
    originReconcileStreamKey: `ap:bench:brotli-queue:${token}:origin`,
    inboundDlqStreamKey: `ap:bench:brotli-queue:${token}:dlq-inbound`,
    outboundDlqStreamKey: `ap:bench:brotli-queue:${token}:dlq-outbound`,
    outboxIntentDlqStreamKey: `ap:bench:brotli-queue:${token}:dlq-intent`,
    originReconcileDlqStreamKey: `ap:bench:brotli-queue:${token}:dlq-origin`,
    consumerGroup: `bench-${token}`,
    blockTimeoutMs: 50,
    claimIdleTimeMs: 60_000,
    maxStreamLength: 100_000,
    readBatchCount: 250,
    claimBatchCount: 250,
    payloadCompression: {
      writeEnabled: arm === "brotli",
      minBytes: 4 * 1024,
      brotliQuality: 0,
    },
  });
  await queue.connect();
  return { queue, intentStream, outboundStream };
}

async function main() {
  const admin = createClient({ url: REDIS_URL });
  await admin.connect();
  const results = [];

  try {
    for (const testCase of CASES) {
      const activity = makeActivity(testCase.activityBytes);
      const targets = makeTargets(testCase.recipients, testCase.endpoints);
      const arms = {
        plaintext: await createArmQueue(testCase.name, "plaintext"),
        brotli: await createArmQueue(testCase.name, "brotli"),
      };
      const samples: Record<Arm, Sample[]> = { plaintext: [], brotli: [] };

      try {
        const totalIterations = WARMUP_SAMPLES + MEASURED_SAMPLES;
        for (let iteration = 0; iteration < totalIterations; iteration += 1) {
          const order: Arm[] = iteration % 2 === 0 ? ["plaintext", "brotli"] : ["brotli", "plaintext"];
          for (const arm of order) {
            const state = arms[arm];
            const sample = await runSample({
              arm,
              testCase,
              sampleIndex: iteration,
              queue: state.queue,
              admin,
              intentStream: state.intentStream,
              outboundStream: state.outboundStream,
              activity,
              targets,
            });
            if (iteration >= WARMUP_SAMPLES) samples[arm].push(sample);
          }
        }
      } finally {
        await Promise.all([arms.plaintext.queue.disconnect(), arms.brotli.queue.disconnect()]);
      }

      const plaintext = summarize(samples.plaintext);
      const brotli = summarize(samples.brotli);
      results.push({
        ...testCase,
        activityActualBytes: Buffer.byteLength(activity),
        targetJsonBytes: Buffer.byteLength(JSON.stringify(targets)),
        plaintext,
        brotli,
        comparisons: {
          p95ElapsedRatio: brotli.elapsedMs.p95 / Math.max(0.0001, plaintext.elapsedMs.p95),
          p99ElapsedRatio: brotli.elapsedMs.p99 / Math.max(0.0001, plaintext.elapsedMs.p99),
          p95CpuRatio: brotli.cpuMicros.p95 / Math.max(1, plaintext.cpuMicros.p95),
          p50MemoryReduction: (plaintext.intentBytes + plaintext.outboundBytes) /
            Math.max(1, brotli.intentBytes + brotli.outboundBytes),
        },
      });
    }

    const guards = {
      maxP95ElapsedRatio: Math.max(...results.map(result => result.comparisons.p95ElapsedRatio)),
      maxP99ElapsedRatio: Math.max(...results.map(result => result.comparisons.p99ElapsedRatio)),
      maxP95CpuRatio: Math.max(...results.map(result => result.comparisons.p95CpuRatio)),
      minMemoryReduction: Math.min(...results.map(result => result.comparisons.p50MemoryReduction)),
    };

    const output = {
      schema: "apdm-redis-stream-brotli-queue-path.v1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      measuredSamplesPerArm: MEASURED_SAMPLES,
      warmupSamplesPerArm: WARMUP_SAMPLES,
      results,
      guards,
      frozenAdspComparison: {
        p95LatencyAllowedRatio: 1.10,
        p99LatencyAllowedRatio: 1.15,
        cpuAllowedRatio: 1.15,
        minimumMaterialMemoryImprovementRatio: 1.10,
        p95Pass: guards.maxP95ElapsedRatio <= 1.10,
        p99Pass: guards.maxP99ElapsedRatio <= 1.15,
        cpuPass: guards.maxP95CpuRatio <= 1.15,
        memoryPass: guards.minMemoryReduction >= 1.10,
      },
      scope: "Redis queue serialization/fanout/consume/decode/ACK path only; excludes remote HTTP delivery and ActivityPods upstream planning",
    };

    const rendered = `${JSON.stringify(output, null, 2)}\n`;
    if (OUTPUT_PATH) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(OUTPUT_PATH), { recursive: true });
      await writeFile(OUTPUT_PATH, rendered);
    }
    process.stdout.write(rendered);
  } finally {
    await admin.quit();
  }
}

await main();