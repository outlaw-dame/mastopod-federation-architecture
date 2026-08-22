import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import kafkaJs from "kafkajs";
import { resolveRedpandaCompression } from "../src/streams/kafka-compression.js";

const { Kafka, logLevel } = kafkaJs;

const BROKER = process.env["REDPANDA_BENCH_BROKER"] ?? "127.0.0.1:19092";
const CONTAINER = process.env["REDPANDA_BENCH_CONTAINER"] ?? "redpanda-compression-bench-v2";
const IMAGE = process.env["REDPANDA_BENCH_IMAGE"] ?? "redpandadata/redpanda:v24.1.3";
const OUTPUT = process.env["REDPANDA_COMPRESSION_BENCH_OUTPUT"] ?? "../measurements/redpanda-compression-v2/summary.json";
const REPEATS = intEnv("REDPANDA_BENCH_REPEATS", 3);
const SAMPLES = intEnv("REDPANDA_BENCH_SAMPLES", 5);
const LATENCY_SAMPLES = intEnv("REDPANDA_BENCH_LATENCY_SAMPLES", 5);
const PARTITIONS = intEnv("REDPANDA_BENCH_PARTITIONS", 6);
const BATCH_SIZE = intEnv("REDPANDA_BENCH_BATCH_SIZE", 100);
const SETTLE_MS = intEnv("REDPANDA_BENCH_SETTLE_MS", 900);

const arms: readonly Arm[] = [
  { id: "none", codec: "none" },
  { id: "gzip", codec: "gzip" },
  { id: "zstd--1", codec: "zstd", zstdLevel: -1 },
  { id: "zstd-1", codec: "zstd", zstdLevel: 1 },
  { id: "zstd-2", codec: "zstd", zstdLevel: 2 },
  { id: "zstd-3", codec: "zstd", zstdLevel: 3 },
  { id: "zstd-4", codec: "zstd", zstdLevel: 4 },
  { id: "zstd-6", codec: "zstd", zstdLevel: 6 },
];

const scenarios: readonly Scenario[] = [
  { id: "short-create", bodyBytes: 1_600, count: 1_200, samples: SAMPLES, batchSize: BATCH_SIZE, latency: false },
  { id: "interaction", bodyBytes: 850, count: 1_500, samples: SAMPLES, batchSize: BATCH_SIZE, latency: false },
  { id: "media-metadata", bodyBytes: 5_500, count: 600, samples: SAMPLES, batchSize: BATCH_SIZE, latency: false },
  { id: "long-article", bodyBytes: 20_000, count: 250, samples: SAMPLES, batchSize: BATCH_SIZE, latency: false },
  { id: "short-create-latency", bodyBytes: 1_600, count: 100, samples: LATENCY_SAMPLES, batchSize: 1, latency: true },
  { id: "interaction-latency", bodyBytes: 850, count: 100, samples: LATENCY_SAMPLES, batchSize: 1, latency: true },
];

type Codec = "none" | "gzip" | "zstd";
type Arm = { id: string; codec: Codec; zstdLevel?: number };
type Scenario = { id: string; bodyBytes: number; count: number; samples: number; batchSize: number; latency: boolean };
type Percentiles = { p50: number; p95: number; p99: number; max: number };
type Counters = { cpuUsec: number; memoryBytes: number; rxBytes: number; txBytes: number };
type Measurement = {
  repeat: number;
  arm: string;
  scenario: Scenario;
  totalMessages: number;
  rawBytes: number;
  topicDiskBytes: number;
  producer: { wallMs: number; cpuMs: number; eventsPerSecond: number; ackLatencyMs: Percentiles; brokerIngressBytes: number; brokerCpuMs: number };
  consumer: { wallMs: number; cpuMs: number; eventsPerSecond: number; brokerEgressBytes: number; brokerCpuMs: number };
};
type ScenarioMedian = Omit<Measurement, "repeat"> & { repeats: number };
type ArmSummary = {
  arm: string;
  scenarios: ScenarioMedian[];
  totalMessages: number;
  rawBytes: number;
  topicDiskBytes: number;
  brokerIngressBytes: number;
  brokerEgressBytes: number;
  producerCpuMs: number;
  consumerCpuMs: number;
  brokerCpuMs: number;
  infrastructureBytesPerEvent: number;
  modeledRf3InfrastructureBytesPerEvent: number;
  cpuMsPerThousandEvents: number;
  throughputEventsPerSecond: number;
  singleton: Record<string, Percentiles>;
  perMillion: { measuredInfrastructureGB: number; modeledRf3InfrastructureGB: number; cpuCoreHours: number };
};

void main();

async function main(): Promise<void> {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  docker(["pull", IMAGE], { stdio: "inherit" });
  const raw: Measurement[] = [];
  try {
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      for (const arm of arms) {
        console.log(`\n=== repeat ${repeat}/${REPEATS}; arm ${arm.id} ===`);
        configureCodec(arm);
        await startBroker();
        await isolatedWarmup(arm);
        for (const scenario of scenarios) raw.push(await measure(repeat, arm, scenario));
        stopBroker();
      }
    }
  } finally {
    stopBroker();
  }

  const summaries = arms.map((arm) => summarizeArm(arm, raw));
  const gzip = required(summaries.find((entry) => entry.arm === "gzip"), "gzip summary");
  const comparisons = summaries.map((entry) => compare(entry, gzip));
  const paretoFrontier = findPareto(comparisons);
  const summary = {
    version: 2,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    redpandaImage: IMAGE,
    methodology: {
      repeats: REPEATS,
      freshBrokerPerArmPerRepeat: true,
      isolatedWarmupTopic: true,
      measuredTopicDeletedAfterEachScenario: true,
      partitions: PARTITIONS,
      replicationFactor: 1,
      acks: -1,
      topicCompressionType: "producer",
      samples: SAMPLES,
      latencySamples: LATENCY_SAMPLES,
      batchSize: BATCH_SIZE,
      guardrails: {
        perMatchingSingletonScenario: true,
        p95MaxVsGzip: 1.10,
        p99MaxVsGzip: 1.15,
        cpuMaxVsGzip: 1.15,
      },
      note: "RF3 infrastructure bytes model multiplies measured topic disk by 3 but does not claim to measure inter-broker replication traffic; a separate multi-broker proof is required before production cost extrapolation.",
    },
    raw,
    arms: summaries,
    comparisons,
    paretoFrontier,
    interpretation: {
      selectionRule: "Do not collapse CPU and infrastructure bytes into an arbitrary single score. Reject candidates that violate matching singleton latency or CPU guardrails, then report the non-dominated cost/performance frontier and break-even cost sensitivity versus GZIP.",
      recommendedNextProof: "Run a three-broker replication-factor-3 benchmark for GZIP and the stable Pareto-leading Zstd candidates before changing production defaults.",
    },
  };
  writeFileSync(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ arms: summaries, comparisons, paretoFrontier }, null, 2));
}

async function isolatedWarmup(arm: Arm): Promise<void> {
  const topic = `bench-warmup-${arm.id}-${randomUUID().slice(0, 8)}`;
  const kafka = client(`warmup-${arm.id}`);
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1, replicationFactor: 1, configEntries: [{ name: "compression.type", value: "producer" }] }] });
  await producer.connect();
  const compression = compressionFor(arm);
  const messages = buildMessages({ id: "short-create", bodyBytes: 1_600, count: 100, samples: 1, batchSize: 100, latency: false }, 100);
  for (let i = 0; i < 3; i += 1) await producer.send({ topic, messages, compression, acks: -1 });
  await producer.disconnect();
  await admin.deleteTopics({ topics: [topic] });
  await admin.disconnect();
  await sleep(250);
}

async function measure(repeat: number, arm: Arm, scenario: Scenario): Promise<Measurement> {
  const topic = `bench-${arm.id}-${scenario.id}-${randomUUID().slice(0, 8)}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const kafka = client(`${arm.id}-${scenario.id}-${repeat}`);
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: PARTITIONS, replicationFactor: 1, configEntries: [{ name: "compression.type", value: "producer" }, { name: "cleanup.policy", value: "delete" }] }] });
  await producer.connect();
  const compression = compressionFor(arm);
  const sourceMessages = buildMessages(scenario, scenario.count);
  const bytesPerSample = sourceMessages.reduce((sum, message) => sum + Buffer.byteLength(message.value), 0);
  const totalMessages = scenario.count * scenario.samples;
  const rawBytes = bytesPerSample * scenario.samples;
  const beforeBroker = counters();
  const beforeCpu = process.cpuUsage();
  const start = performance.now();
  const ack: number[] = [];
  for (let sample = 0; sample < scenario.samples; sample += 1) {
    for (let offset = 0; offset < sourceMessages.length; offset += scenario.batchSize) {
      const batch = sourceMessages.slice(offset, offset + scenario.batchSize).map((message, index) => ({ ...message, key: `${message.key}-${sample}-${offset + index}` }));
      const t0 = performance.now();
      await producer.send({ topic, messages: batch, compression, acks: -1 });
      ack.push(performance.now() - t0);
    }
  }
  const wallMs = performance.now() - start;
  const producerCpu = cpuMs(process.cpuUsage(beforeCpu));
  const afterProducerBroker = counters();
  await producer.disconnect();
  await sleep(SETTLE_MS);
  syncBroker();
  const topicDiskBytes = diskUsage(topic);

  const beforeConsumerBroker = counters();
  const beforeConsumerCpu = process.cpuUsage();
  const consumerStart = performance.now();
  await consumeExactly(kafka, topic, totalMessages);
  const consumerWallMs = performance.now() - consumerStart;
  const consumerCpu = cpuMs(process.cpuUsage(beforeConsumerCpu));
  const afterConsumerBroker = counters();

  await admin.deleteTopics({ topics: [topic] });
  await admin.disconnect();
  await sleep(100);

  const result: Measurement = {
    repeat,
    arm: arm.id,
    scenario,
    totalMessages,
    rawBytes,
    topicDiskBytes,
    producer: {
      wallMs: round(wallMs),
      cpuMs: round(producerCpu),
      eventsPerSecond: round(totalMessages / (wallMs / 1000)),
      ackLatencyMs: percentiles(ack),
      brokerIngressBytes: afterProducerBroker.rxBytes - beforeBroker.rxBytes,
      brokerCpuMs: round((afterProducerBroker.cpuUsec - beforeBroker.cpuUsec) / 1000),
    },
    consumer: {
      wallMs: round(consumerWallMs),
      cpuMs: round(consumerCpu),
      eventsPerSecond: round(totalMessages / (consumerWallMs / 1000)),
      brokerEgressBytes: afterConsumerBroker.txBytes - beforeConsumerBroker.txBytes,
      brokerCpuMs: round((afterConsumerBroker.cpuUsec - beforeConsumerBroker.cpuUsec) / 1000),
    },
  };
  console.log(JSON.stringify(result));
  return result;
}

function summarizeArm(arm: Arm, raw: Measurement[]): ArmSummary {
  const scenarioMedians = scenarios.map((scenario) => medianScenario(arm.id, scenario, raw));
  const totalMessages = scenarioMedians.reduce((sum, item) => sum + item.totalMessages, 0);
  const rawBytes = scenarioMedians.reduce((sum, item) => sum + item.rawBytes, 0);
  const topicDiskBytes = scenarioMedians.reduce((sum, item) => sum + item.topicDiskBytes, 0);
  const brokerIngressBytes = scenarioMedians.reduce((sum, item) => sum + item.producer.brokerIngressBytes, 0);
  const brokerEgressBytes = scenarioMedians.reduce((sum, item) => sum + item.consumer.brokerEgressBytes, 0);
  const producerCpuMs = scenarioMedians.reduce((sum, item) => sum + item.producer.cpuMs, 0);
  const consumerCpuMs = scenarioMedians.reduce((sum, item) => sum + item.consumer.cpuMs, 0);
  const brokerCpuMs = scenarioMedians.reduce((sum, item) => sum + item.producer.brokerCpuMs + item.consumer.brokerCpuMs, 0);
  const totalCpuMs = producerCpuMs + consumerCpuMs + brokerCpuMs;
  const infra = topicDiskBytes + brokerIngressBytes;
  const rf3Infra = topicDiskBytes * 3 + brokerIngressBytes;
  const singleton = Object.fromEntries(scenarioMedians.filter((item) => item.scenario.latency).map((item) => [item.scenario.id, item.producer.ackLatencyMs]));
  const throughputWall = scenarioMedians.filter((item) => !item.scenario.latency).reduce((sum, item) => sum + item.producer.wallMs, 0);
  const throughputMessages = scenarioMedians.filter((item) => !item.scenario.latency).reduce((sum, item) => sum + item.totalMessages, 0);
  return {
    arm: arm.id,
    scenarios: scenarioMedians,
    totalMessages,
    rawBytes,
    topicDiskBytes,
    brokerIngressBytes,
    brokerEgressBytes,
    producerCpuMs,
    consumerCpuMs,
    brokerCpuMs,
    infrastructureBytesPerEvent: round(infra / totalMessages),
    modeledRf3InfrastructureBytesPerEvent: round(rf3Infra / totalMessages),
    cpuMsPerThousandEvents: round((totalCpuMs / totalMessages) * 1000),
    throughputEventsPerSecond: round(throughputMessages / (throughputWall / 1000)),
    singleton,
    perMillion: {
      measuredInfrastructureGB: round((infra / totalMessages) * 1_000_000 / 1_000_000_000),
      modeledRf3InfrastructureGB: round((rf3Infra / totalMessages) * 1_000_000 / 1_000_000_000),
      cpuCoreHours: round((totalCpuMs / totalMessages) * 1_000_000 / 3_600_000),
    },
  };
}

function medianScenario(arm: string, scenario: Scenario, raw: Measurement[]): ScenarioMedian {
  const items = raw.filter((item) => item.arm === arm && item.scenario.id === scenario.id);
  if (items.length !== REPEATS) throw new Error(`${arm}/${scenario.id}: expected ${REPEATS} repeats, got ${items.length}`);
  const first = items[0]!;
  return {
    arm,
    scenario,
    repeats: items.length,
    totalMessages: first.totalMessages,
    rawBytes: first.rawBytes,
    topicDiskBytes: median(items.map((item) => item.topicDiskBytes)),
    producer: {
      wallMs: median(items.map((item) => item.producer.wallMs)),
      cpuMs: median(items.map((item) => item.producer.cpuMs)),
      eventsPerSecond: median(items.map((item) => item.producer.eventsPerSecond)),
      ackLatencyMs: {
        p50: median(items.map((item) => item.producer.ackLatencyMs.p50)),
        p95: median(items.map((item) => item.producer.ackLatencyMs.p95)),
        p99: median(items.map((item) => item.producer.ackLatencyMs.p99)),
        max: median(items.map((item) => item.producer.ackLatencyMs.max)),
      },
      brokerIngressBytes: median(items.map((item) => item.producer.brokerIngressBytes)),
      brokerCpuMs: median(items.map((item) => item.producer.brokerCpuMs)),
    },
    consumer: {
      wallMs: median(items.map((item) => item.consumer.wallMs)),
      cpuMs: median(items.map((item) => item.consumer.cpuMs)),
      eventsPerSecond: median(items.map((item) => item.consumer.eventsPerSecond)),
      brokerEgressBytes: median(items.map((item) => item.consumer.brokerEgressBytes)),
      brokerCpuMs: median(items.map((item) => item.consumer.brokerCpuMs)),
    },
  };
}

function compare(candidate: ArmSummary, gzip: ArmSummary) {
  const reasons: string[] = [];
  for (const scenario of scenarios.filter((entry) => entry.latency)) {
    const c = required(candidate.singleton[scenario.id], `${candidate.arm}/${scenario.id}`);
    const g = required(gzip.singleton[scenario.id], `gzip/${scenario.id}`);
    if (c.p95 / g.p95 > 1.10) reasons.push(`${scenario.id} p95 ${(c.p95 / g.p95).toFixed(3)}x > 1.10x GZIP`);
    if (c.p99 / g.p99 > 1.15) reasons.push(`${scenario.id} p99 ${(c.p99 / g.p99).toFixed(3)}x > 1.15x GZIP`);
  }
  const cpuRatio = candidate.cpuMsPerThousandEvents / gzip.cpuMsPerThousandEvents;
  if (cpuRatio > 1.15) reasons.push(`total CPU ${cpuRatio.toFixed(3)}x > 1.15x GZIP`);
  const measuredExtraGB = candidate.perMillion.measuredInfrastructureGB - gzip.perMillion.measuredInfrastructureGB;
  const rf3ExtraGB = candidate.perMillion.modeledRf3InfrastructureGB - gzip.perMillion.modeledRf3InfrastructureGB;
  const cpuSavedCoreHours = gzip.perMillion.cpuCoreHours - candidate.perMillion.cpuCoreHours;
  return {
    arm: candidate.arm,
    eligible: reasons.length === 0,
    reasons,
    ratiosToGzip: {
      measuredInfrastructure: round(candidate.perMillion.measuredInfrastructureGB / gzip.perMillion.measuredInfrastructureGB),
      modeledRf3Infrastructure: round(candidate.perMillion.modeledRf3InfrastructureGB / gzip.perMillion.modeledRf3InfrastructureGB),
      totalCpu: round(cpuRatio),
      throughput: round(candidate.throughputEventsPerSecond / gzip.throughputEventsPerSecond),
    },
    deltaPerMillionVsGzip: {
      measuredInfrastructureGB: round(measuredExtraGB),
      modeledRf3InfrastructureGB: round(rf3ExtraGB),
      cpuCoreHours: round(candidate.perMillion.cpuCoreHours - gzip.perMillion.cpuCoreHours),
    },
    breakEvenInfrastructureDollarPerGB: Object.fromEntries([0.02, 0.05, 0.10, 0.20].map((cpuDollarPerCoreHour) => [String(cpuDollarPerCoreHour), measuredExtraGB > 0 && cpuSavedCoreHours > 0 ? round((cpuSavedCoreHours * cpuDollarPerCoreHour) / measuredExtraGB) : null])),
  };
}

function findPareto(comparisons: ReturnType<typeof compare>[]) {
  const eligible = comparisons.filter((item) => item.eligible);
  return eligible.filter((candidate) => !eligible.some((other) => other.arm !== candidate.arm && other.ratiosToGzip.measuredInfrastructure <= candidate.ratiosToGzip.measuredInfrastructure && other.ratiosToGzip.totalCpu <= candidate.ratiosToGzip.totalCpu && (other.ratiosToGzip.measuredInfrastructure < candidate.ratiosToGzip.measuredInfrastructure || other.ratiosToGzip.totalCpu < candidate.ratiosToGzip.totalCpu))).map((item) => item.arm);
}

function buildMessages(scenario: Scenario, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const actor = `https://pod.example/users/user-${index % 200}`;
    const kind = scenario.id.replace(/-latency$/, "");
    const activity = activityFor(kind, actor, index, scenario.bodyBytes);
    return {
      key: actor,
      value: JSON.stringify({ activity, actorUri: actor, publishedAt: 1_780_000_000_000 + index, origin: "local", streamTimestamp: 1_780_000_000_000 + index, meta: { isPublicActivity: true, isPublicIndexable: true, visibility: "public", searchConsent: { isPublic: true, source: "compression-benchmark" }, hashtags: ["activitypub", "fediverse", `topic-${index % 31}`] } }),
      headers: { "activity-type": String(activity.type), "actor-uri": actor, origin: "local", "search-consent": "public" },
    };
  });
}

function activityFor(kind: string, actor: string, index: number, bodyBytes: number): Record<string, unknown> {
  const id = `https://pod.example/activities/${kind}-${index}`;
  if (kind === "interaction") return { "@context": "https://www.w3.org/ns/activitystreams", id, type: index % 3 === 0 ? "Like" : index % 3 === 1 ? "Announce" : "Follow", actor, object: `https://remote.example/objects/${index % 500}`, to: ["https://www.w3.org/ns/activitystreams#Public"], published: new Date(1_780_000_000_000 + index).toISOString() };
  const content = text(bodyBytes, index);
  const object: Record<string, unknown> = { id: `https://pod.example/objects/${kind}-${index}`, type: kind === "long-article" ? "Article" : "Note", attributedTo: actor, content, published: new Date(1_780_000_000_000 + index).toISOString(), to: ["https://www.w3.org/ns/activitystreams#Public"], tag: [{ type: "Hashtag", name: "#activitypub" }, { type: "Hashtag", name: `#topic${index % 31}` }] };
  if (kind === "media-metadata") object.attachment = Array.from({ length: 4 }, (_, media) => ({ type: "Document", mediaType: media % 2 ? "image/webp" : "image/jpeg", url: `https://cdn.pod.example/media/${index}-${media}-${hashish(index * 17 + media)}`, name: `attachment ${media} ${hashish(index + media)}`, width: 2048, height: 1365 }));
  return { "@context": "https://www.w3.org/ns/activitystreams", id, type: "Create", actor, object, to: ["https://www.w3.org/ns/activitystreams#Public"], cc: [`https://pod.example/users/user-${index % 200}/followers`] };
}

function text(target: number, seed: number): string {
  const phrases = ["distributed social systems should remain fast affordable and interoperable", "public activities carry repeated JSON LD structure plus unique user generated text", "federation workloads mix short notes links replies hashtags and longer articles", "compression trades compute for network storage and replication efficiency", "the benchmark varies identifiers words and metadata so the corpus is not a single repeated string"];
  let out = "";
  let i = 0;
  while (Buffer.byteLength(out) < target) { out += `${phrases[(seed + i) % phrases.length]} token-${hashish(seed * 131 + i)} `; i += 1; }
  return out.slice(0, target);
}

function hashish(value: number): string { let x = (value ^ 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x21f0aaad); x = Math.imul(x ^ (x >>> 15), 0x735a2d97); return (x ^ (x >>> 15)).toString(36).padStart(7, "0"); }

function client(clientId: string) { return new Kafka({ clientId: `redpanda-compression-v2-${clientId}`, brokers: [BROKER], connectionTimeout: 10_000, requestTimeout: 30_000, logLevel: logLevel.NOTHING, retry: { retries: 8, initialRetryTime: 100 } }); }

async function consumeExactly(kafka: InstanceType<typeof Kafka>, topic: string, expected: number): Promise<void> {
  const consumer = kafka.consumer({ groupId: `bench-${randomUUID()}`, maxBytesPerPartition: 16 * 1024 * 1024 });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  let seen = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${topic}: consumer timed out at ${seen}/${expected}`)), 30_000);
    void consumer.run({ eachBatchAutoResolve: true, eachBatch: async ({ batch }) => { seen += batch.messages.length; if (seen >= expected) { clearTimeout(timer); resolve(); } } }).catch((error) => { clearTimeout(timer); reject(error); });
  });
  await consumer.stop();
  await consumer.disconnect();
  if (seen !== expected) throw new Error(`${topic}: expected exactly ${expected}, observed ${seen}`);
}

function configureCodec(arm: Arm): void { process.env["REDPANDA_COMPRESSION"] = arm.codec; if (arm.zstdLevel === undefined) delete process.env["REDPANDA_ZSTD_LEVEL"]; else process.env["REDPANDA_ZSTD_LEVEL"] = String(arm.zstdLevel); resolveRedpandaCompression(arm.codec); }
function compressionFor(arm: Arm) { configureCodec(arm); return resolveRedpandaCompression(arm.codec).type; }

async function startBroker(): Promise<void> {
  stopBroker();
  docker(["run", "-d", "--name", CONTAINER, "-p", "19092:19092", IMAGE, "redpanda", "start", "--overprovisioned", "--smp", "1", "--memory", "1024M", "--reserve-memory", "0M", "--node-id", "0", "--check=false", "--kafka-addr", "internal://0.0.0.0:9092,external://0.0.0.0:19092", "--advertise-kafka-addr", "internal://127.0.0.1:9092,external://127.0.0.1:19092"]);
  for (let i = 0; i < 60; i += 1) { try { docker(["exec", CONTAINER, "rpk", "cluster", "health", "--exit-when-healthy"]); return; } catch { await sleep(250); } }
  throw new Error("Redpanda did not become healthy");
}
function stopBroker(): void { try { docker(["rm", "-f", CONTAINER]); } catch {} }
function syncBroker(): void { try { docker(["exec", CONTAINER, "sync"]); } catch {} }
function counters(): Counters { const cpu = dockerText(["exec", CONTAINER, "sh", "-c", "awk '/usage_usec/ {print $2}' /sys/fs/cgroup/cpu.stat"]); const memory = dockerText(["exec", CONTAINER, "cat", "/sys/fs/cgroup/memory.current"]); const rx = dockerText(["exec", CONTAINER, "cat", "/sys/class/net/eth0/statistics/rx_bytes"]); const tx = dockerText(["exec", CONTAINER, "cat", "/sys/class/net/eth0/statistics/tx_bytes"]); return { cpuUsec: Number(cpu), memoryBytes: Number(memory), rxBytes: Number(rx), txBytes: Number(tx) }; }
function diskUsage(topic: string): number { const output = dockerText(["exec", CONTAINER, "sh", "-c", `du -sb /var/lib/redpanda/data/kafka/${topic}-* 2>/dev/null | awk '{s+=$1} END {print s+0}'`]); return Number(output); }
function docker(args: string[], options: { stdio?: "inherit" } = {}): string { return execFileSync("docker", args, { encoding: "utf8", stdio: options.stdio ?? "pipe" }).trim(); }
function dockerText(args: string[]): string { return docker(args); }
function cpuMs(usage: NodeJS.CpuUsage): number { return (usage.user + usage.system) / 1000; }
function percentiles(values: number[]): Percentiles { const sorted = [...values].sort((a, b) => a - b); return { p50: round(q(sorted, 0.50)), p95: round(q(sorted, 0.95)), p99: round(q(sorted, 0.99)), max: round(sorted.at(-1) ?? 0) }; }
function q(sorted: number[], quantile: number): number { if (!sorted.length) return 0; const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1)); return sorted[index]!; }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2); }
function round(value: number): number { return Number(value.toFixed(6)); }
function intEnv(name: string, fallback: number): number { const value = Number.parseInt(process.env[name] ?? String(fallback), 10); if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`); return value; }
function dirname(path: string): string { const index = path.lastIndexOf("/"); return index < 0 ? "." : path.slice(0, index); }
function required<T>(value: T | undefined, label: string): T { if (value === undefined) throw new Error(`Missing ${label}`); return value; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
