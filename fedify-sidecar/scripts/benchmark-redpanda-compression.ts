import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import kafkaJs from "kafkajs";
import { resolveRedpandaCompression } from "../src/streams/kafka-compression.js";

const { Kafka, logLevel } = kafkaJs;

const BROKER_HOST = process.env["REDPANDA_BENCH_BROKER"] ?? "127.0.0.1:19092";
const CONTAINER_NAME = process.env["REDPANDA_BENCH_CONTAINER"] ?? "redpanda-compression-bench";
const REDPANDA_IMAGE = process.env["REDPANDA_BENCH_IMAGE"] ?? "redpandadata/redpanda:v24.1.3";
const OUTPUT = process.env["REDPANDA_COMPRESSION_BENCH_OUTPUT"] ?? "../measurements/redpanda-compression/summary.json";
const SAMPLE_COUNT = parsePositiveInt("REDPANDA_BENCH_SAMPLES", 5);
const LATENCY_SAMPLE_COUNT = parsePositiveInt("REDPANDA_BENCH_LATENCY_SAMPLES", 3);
const PARTITIONS = parsePositiveInt("REDPANDA_BENCH_PARTITIONS", 6);
const BATCH_SIZE = parsePositiveInt("REDPANDA_BENCH_BATCH_SIZE", 100);
const SETTLE_MS = parsePositiveInt("REDPANDA_BENCH_SETTLE_MS", 1200);
const REQUEST_TIMEOUT_MS = parsePositiveInt("REDPANDA_BENCH_REQUEST_TIMEOUT_MS", 30_000);

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

const throughputScenarios: readonly Scenario[] = [
  { id: "short-create", targetBodyBytes: 1_600, messagesPerSample: 1_200, mode: "batched", batchSize: BATCH_SIZE },
  { id: "interaction", targetBodyBytes: 850, messagesPerSample: 1_500, mode: "batched", batchSize: BATCH_SIZE },
  { id: "media-metadata", targetBodyBytes: 5_500, messagesPerSample: 600, mode: "batched", batchSize: BATCH_SIZE },
  { id: "long-article", targetBodyBytes: 20_000, messagesPerSample: 250, mode: "batched", batchSize: BATCH_SIZE },
];

const latencyScenarios: readonly Scenario[] = [
  { id: "short-create", targetBodyBytes: 1_600, messagesPerSample: 100, mode: "singleton", batchSize: 1 },
  { id: "interaction", targetBodyBytes: 850, messagesPerSample: 100, mode: "singleton", batchSize: 1 },
];

type CodecName = "none" | "gzip" | "zstd";
type ScenarioMode = "batched" | "singleton";

type Arm = {
  id: string;
  codec: CodecName;
  zstdLevel?: number;
};

type Scenario = {
  id: string;
  targetBodyBytes: number;
  messagesPerSample: number;
  mode: ScenarioMode;
  batchSize: number;
};

type BrokerCounters = {
  cpuUsec: number;
  memoryBytes: number;
  rxBytes: number;
  txBytes: number;
};

type ScenarioResult = {
  scenario: Scenario;
  samples: number;
  totalMessages: number;
  serializedMessageBytes: number;
  rawBytes: number;
  topicDiskBytes: number;
  producer: {
    wallMs: number;
    cpuMs: number;
    eventsPerSecond: number;
    cpuMsPerThousandEvents: number;
    ackLatencyMs: Percentiles;
    brokerIngressBytes: number;
    brokerEgressAckBytes: number;
    brokerCpuMs: number;
    brokerMemoryBeforeBytes: number;
    brokerMemoryAfterBytes: number;
  };
  consumer: {
    wallMs: number;
    cpuMs: number;
    eventsPerSecond: number;
    cpuMsPerThousandEvents: number;
    brokerIngressAckBytes: number;
    brokerEgressBytes: number;
    brokerCpuMs: number;
    brokerMemoryAfterBytes: number;
  };
};

type Percentiles = {
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

type ArmResult = {
  arm: Arm;
  nodeVersion: string;
  redpandaImage: string;
  scenarios: ScenarioResult[];
  aggregate: Aggregate;
};

type Aggregate = {
  totalMessages: number;
  rawBytes: number;
  topicDiskBytes: number;
  diskBytesPerRawByte: number;
  brokerIngressBytes: number;
  ingressBytesPerRawByte: number;
  brokerEgressBytes: number;
  producerCpuMsPerThousandEvents: number;
  consumerCpuMsPerThousandEvents: number;
  brokerCpuMsPerThousandEvents: number;
  throughputEventsPerSecond: number;
  singletonAckLatencyMs: Percentiles;
};

type CandidateComparison = {
  arm: string;
  eligible: boolean;
  ratiosToGzip: {
    singletonP95: number;
    singletonP99: number;
    producerCpu: number;
    consumerCpu: number;
    brokerCpu: number;
  };
  infrastructureBytes: number;
  infrastructureBytesRatioToGzip: number;
  totalCpuMsPerThousandEvents: number;
  rejectionReasons: string[];
};

void main();

async function main(): Promise<void> {
  mkdirSync(OUTPUT.slice(0, Math.max(OUTPUT.lastIndexOf("/"), 0)) || ".", { recursive: true });

  docker(["pull", REDPANDA_IMAGE], { stdio: "inherit" });
  const results: ArmResult[] = [];

  try {
    for (const arm of arms) {
      console.log(`\n=== Redpanda compression arm: ${arm.id} ===`);
      await startFreshBroker();
      configureCodec(arm);

      const scenarios: ScenarioResult[] = [];
      for (const scenario of throughputScenarios) {
        scenarios.push(await runScenario(arm, scenario, SAMPLE_COUNT));
      }
      for (const scenario of latencyScenarios) {
        scenarios.push(await runScenario(arm, scenario, LATENCY_SAMPLE_COUNT));
      }

      results.push({
        arm,
        nodeVersion: process.versions.node,
        redpandaImage: REDPANDA_IMAGE,
        scenarios,
        aggregate: aggregateArm(scenarios),
      });

      stopBroker();
    }
  } finally {
    stopBroker();
  }

  const decision = buildDecision(results);
  const summary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      broker: {
        image: REDPANDA_IMAGE,
        smp: 1,
        memory: "1024M",
        reserveMemory: "0M",
        partitions: PARTITIONS,
        freshBrokerPerArm: true,
        topicCompressionType: "producer",
        acks: -1,
      },
      samples: SAMPLE_COUNT,
      singletonLatencySamples: LATENCY_SAMPLE_COUNT,
      batchSize: BATCH_SIZE,
      payloads: throughputScenarios,
      latencyPayloads: latencyScenarios,
      guardrailsRelativeToGzip: {
        singletonP95MaxRatio: 1.10,
        singletonP99MaxRatio: 1.15,
        producerCpuMaxRatio: 1.15,
        consumerCpuMaxRatio: 1.15,
        brokerCpuMaxRatio: 1.15,
      },
      selectionRule: "Among candidates that satisfy all GZIP-relative performance/CPU guardrails, minimize broker-ingress plus Redpanda-topic-disk bytes. If candidates are within 5%, prefer lower total producer+consumer+broker CPU. No codec dependencies beyond KafkaJS core and Node native Zstd are benchmarked.",
    },
    arms: results,
    decision,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nCompression benchmark summary written to ${OUTPUT}`);
  console.log(JSON.stringify(decision, null, 2));

  if (!decision.selectedArm) {
    throw new Error("Compression benchmark produced no eligible candidate");
  }
}

async function runScenario(arm: Arm, scenario: Scenario, samples: number): Promise<ScenarioResult> {
  const topic = sanitizeTopic(`bench.${arm.id}.${scenario.mode}.${scenario.id}.${randomUUID().slice(0, 8)}`);
  const kafka = new Kafka({
    clientId: `compression-bench-${arm.id}-${scenario.id}-${scenario.mode}`,
    brokers: [BROKER_HOST],
    connectionTimeout: 10_000,
    requestTimeout: REQUEST_TIMEOUT_MS,
    logLevel: logLevel.NOTHING,
    retry: { retries: 8, initialRetryTime: 100 },
  });
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });

  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [{
      topic,
      numPartitions: PARTITIONS,
      replicationFactor: 1,
      configEntries: [
        { name: "compression.type", value: "producer" },
        { name: "cleanup.policy", value: "delete" },
      ],
    }],
  });
  await admin.disconnect();
  await producer.connect();

  const codec = resolveArmCompression(arm);
  const messages = buildMessages(scenario, scenario.messagesPerSample);
  const serializedMessageBytes = messages.reduce((sum, message) => sum + Buffer.byteLength(message.value), 0);
  const totalMessages = scenario.messagesPerSample * samples;
  const rawBytes = serializedMessageBytes * samples;

  // One untimed warmup batch keeps connection setup/JIT work out of measurements.
  await producer.send({
    topic,
    messages: messages.slice(0, Math.min(messages.length, scenario.batchSize)),
    compression: codec,
    acks: -1,
  });

  const producerBeforeBroker = brokerCounters();
  const producerBeforeCpu = process.cpuUsage();
  const producerStart = performance.now();
  const ackLatencies: number[] = [];

  for (let sample = 0; sample < samples; sample += 1) {
    for (let offset = 0; offset < messages.length; offset += scenario.batchSize) {
      const batch = messages.slice(offset, offset + scenario.batchSize).map((message, index) => ({
        ...message,
        key: `${message.key}-${sample}-${offset + index}`,
      }));
      const started = performance.now();
      await producer.send({ topic, messages: batch, compression: codec, acks: -1 });
      ackLatencies.push(performance.now() - started);
    }
  }

  const producerWallMs = performance.now() - producerStart;
  const producerCpu = process.cpuUsage(producerBeforeCpu);
  const producerAfterBroker = brokerCounters();
  await producer.disconnect();

  await sleep(SETTLE_MS);
  syncBroker();
  const topicDiskBytes = topicDiskUsage(topic);

  const consumerBeforeBroker = brokerCounters();
  const consumerBeforeCpu = process.cpuUsage();
  const consumerStart = performance.now();
  await consumeExactly(kafka, topic, totalMessages + Math.min(messages.length, scenario.batchSize));
  const consumerWallMs = performance.now() - consumerStart;
  const consumerCpu = process.cpuUsage(consumerBeforeCpu);
  const consumerAfterBroker = brokerCounters();

  const producerCpuMs = cpuMs(producerCpu);
  const consumerCpuMs = cpuMs(consumerCpu);

  const result: ScenarioResult = {
    scenario,
    samples,
    totalMessages,
    serializedMessageBytes,
    rawBytes,
    topicDiskBytes,
    producer: {
      wallMs: round(producerWallMs),
      cpuMs: round(producerCpuMs),
      eventsPerSecond: round(totalMessages / (producerWallMs / 1_000)),
      cpuMsPerThousandEvents: round((producerCpuMs / totalMessages) * 1_000),
      ackLatencyMs: percentiles(ackLatencies),
      brokerIngressBytes: producerAfterBroker.rxBytes - producerBeforeBroker.rxBytes,
      brokerEgressAckBytes: producerAfterBroker.txBytes - producerBeforeBroker.txBytes,
      brokerCpuMs: round((producerAfterBroker.cpuUsec - producerBeforeBroker.cpuUsec) / 1_000),
      brokerMemoryBeforeBytes: producerBeforeBroker.memoryBytes,
      brokerMemoryAfterBytes: producerAfterBroker.memoryBytes,
    },
    consumer: {
      wallMs: round(consumerWallMs),
      cpuMs: round(consumerCpuMs),
      eventsPerSecond: round(totalMessages / (consumerWallMs / 1_000)),
      cpuMsPerThousandEvents: round((consumerCpuMs / totalMessages) * 1_000),
      brokerIngressAckBytes: consumerAfterBroker.rxBytes - consumerBeforeBroker.rxBytes,
      brokerEgressBytes: consumerAfterBroker.txBytes - consumerBeforeBroker.txBytes,
      brokerCpuMs: round((consumerAfterBroker.cpuUsec - consumerBeforeBroker.cpuUsec) / 1_000),
      brokerMemoryAfterBytes: consumerAfterBroker.memoryBytes,
    },
  };

  console.log(JSON.stringify({ arm: arm.id, scenario: `${scenario.mode}/${scenario.id}`, result }, null, 2));
  return result;
}

function buildMessages(scenario: Scenario, count: number): Array<{ key: string; value: string; headers: Record<string, string> }> {
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    const activity = realisticActivity(scenario.id, scenario.targetBodyBytes, i);
    const value = JSON.stringify({
      activity,
      actorUri: activity.actor,
      publishedAt: 1_780_000_000_000 + i,
      origin: "local",
      streamTimestamp: 1_780_000_000_000 + i,
      meta: {
        isPublicActivity: true,
        isPublicIndexable: true,
        visibility: "public",
        searchConsent: { isPublic: true, source: "benchmark-fixture" },
        hashtags: ["activitypub", "fediverse"],
      },
    });
    messages.push({
      key: `https://pod.example/users/user-${i % 200}`,
      value,
      headers: {
        "activity-type": activity.type,
        "actor-uri": activity.actor,
        origin: "local",
        "search-consent": "public",
      },
    });
  }
  return messages;
}

function realisticActivity(kind: string, targetBodyBytes: number, index: number): Record<string, any> {
  const actor = `https://pod.example/users/user-${index % 200}`;
  const id = `https://pod.example/activities/${kind}-${index}`;
  const body = buildNaturalishText(targetBodyBytes, index);

  if (kind === "interaction") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id,
      type: index % 3 === 0 ? "Like" : index % 3 === 1 ? "Announce" : "Follow",
      actor,
      object: `https://remote.example/objects/${index % 500}`,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      published: new Date(1_780_000_000_000 + index * 1_000).toISOString(),
      summary: body.slice(0, Math.max(0, targetBodyBytes - 500)),
    };
  }

  const attachment = kind === "media-metadata"
    ? Array.from({ length: 4 }, (_, attachmentIndex) => ({
        type: "Document",
        mediaType: attachmentIndex % 2 === 0 ? "image/avif" : "image/webp",
        url: `https://media.example/${index}/${attachmentIndex}/original.avif`,
        name: `Accessible media description ${index}-${attachmentIndex}: ${body.slice(0, 180)}`,
        width: 2048,
        height: 1365,
        blurhash: `LEHV6nWB2yk8pyo0adR*.7kCMdnj-${index % 97}`,
      }))
    : undefined;

  return {
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id,
    type: "Create",
    actor,
    published: new Date(1_780_000_000_000 + index * 1_000).toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${actor}/followers`],
    object: {
      id: `https://pod.example/objects/${kind}-${index}`,
      type: kind === "long-article" ? "Article" : "Note",
      attributedTo: actor,
      content: `<p>${body}</p>`,
      mediaType: "text/html",
      url: `https://pod.example/@user-${index % 200}/posts/${index}`,
      tag: [
        { type: "Hashtag", name: "#activitypub", href: "https://pod.example/tags/activitypub" },
        { type: "Hashtag", name: "#fediverse", href: "https://pod.example/tags/fediverse" },
      ],
      attachment,
      replies: { type: "Collection", totalItems: index % 23 },
      likes: { type: "Collection", totalItems: index % 91 },
      shares: { type: "Collection", totalItems: index % 37 },
    },
  };
}

function buildNaturalishText(targetBytes: number, seed: number): string {
  const words = [
    "federated", "social", "community", "conversation", "ActivityPub", "portable", "identity",
    "public", "timeline", "reader", "network", "local", "distributed", "semantic", "media",
    "privacy", "open", "protocol", "article", "reply", "context", "people", "software", "web",
    "performance", "scalable", "efficient", "storage", "latency", "stream", "event", "pod",
  ];
  let state = (seed + 1) * 0x9e3779b1;
  let output = "";
  while (Buffer.byteLength(output) < targetBytes) {
    state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x27100001) >>> 0;
    const word = words[state % words.length];
    const suffix = state % 29 === 0 ? ` https://example.net/r/${state.toString(36)}` : "";
    output += `${word}${suffix}${state % 17 === 0 ? ". " : " "}`;
  }
  return output.slice(0, targetBytes);
}

async function consumeExactly(kafka: InstanceType<typeof Kafka>, topic: string, expected: number): Promise<void> {
  const consumer = kafka.consumer({ groupId: `compression-bench-${topic}-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  let seen = 0;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const timeout = setTimeout(() => rejectDone(new Error(`Timed out consuming ${topic}: saw ${seen}/${expected}`)), 120_000);

  const run = consumer.run({
    eachBatchAutoResolve: true,
    eachBatch: async ({ batch }) => {
      seen += batch.messages.length;
      if (seen >= expected) resolveDone();
    },
  });

  try {
    await done;
  } finally {
    clearTimeout(timeout);
    await consumer.stop();
    await run;
    await consumer.disconnect();
  }
}

function aggregateArm(scenarios: ScenarioResult[]): Aggregate {
  const throughput = scenarios.filter((result) => result.scenario.mode === "batched");
  const singleton = scenarios.filter((result) => result.scenario.mode === "singleton");
  const totalMessages = throughput.reduce((sum, result) => sum + result.totalMessages, 0);
  const rawBytes = throughput.reduce((sum, result) => sum + result.rawBytes, 0);
  const topicDiskBytes = throughput.reduce((sum, result) => sum + result.topicDiskBytes, 0);
  const brokerIngressBytes = throughput.reduce((sum, result) => sum + result.producer.brokerIngressBytes, 0);
  const brokerEgressBytes = throughput.reduce((sum, result) => sum + result.consumer.brokerEgressBytes, 0);
  const producerCpuMs = throughput.reduce((sum, result) => sum + result.producer.cpuMs, 0);
  const consumerCpuMs = throughput.reduce((sum, result) => sum + result.consumer.cpuMs, 0);
  const brokerCpuMs = throughput.reduce((sum, result) => sum + result.producer.brokerCpuMs + result.consumer.brokerCpuMs, 0);
  const producerWallMs = throughput.reduce((sum, result) => sum + result.producer.wallMs, 0);
  const singletonLatencies = singleton.flatMap((result) => expandPercentileApproximation(result.producer.ackLatencyMs));

  return {
    totalMessages,
    rawBytes,
    topicDiskBytes,
    diskBytesPerRawByte: round(topicDiskBytes / rawBytes, 6),
    brokerIngressBytes,
    ingressBytesPerRawByte: round(brokerIngressBytes / rawBytes, 6),
    brokerEgressBytes,
    producerCpuMsPerThousandEvents: round((producerCpuMs / totalMessages) * 1_000),
    consumerCpuMsPerThousandEvents: round((consumerCpuMs / totalMessages) * 1_000),
    brokerCpuMsPerThousandEvents: round((brokerCpuMs / totalMessages) * 1_000),
    throughputEventsPerSecond: round(totalMessages / (producerWallMs / 1_000)),
    singletonAckLatencyMs: percentiles(singletonLatencies),
  };
}

function buildDecision(results: ArmResult[]) {
  const gzip = results.find((result) => result.arm.id === "gzip");
  if (!gzip) throw new Error("GZIP baseline missing");

  const comparisons: CandidateComparison[] = results.map((result) => {
    const g = gzip.aggregate;
    const a = result.aggregate;
    const ratios = {
      singletonP95: ratio(a.singletonAckLatencyMs.p95, g.singletonAckLatencyMs.p95),
      singletonP99: ratio(a.singletonAckLatencyMs.p99, g.singletonAckLatencyMs.p99),
      producerCpu: ratio(a.producerCpuMsPerThousandEvents, g.producerCpuMsPerThousandEvents),
      consumerCpu: ratio(a.consumerCpuMsPerThousandEvents, g.consumerCpuMsPerThousandEvents),
      brokerCpu: ratio(a.brokerCpuMsPerThousandEvents, g.brokerCpuMsPerThousandEvents),
    };
    const rejectionReasons: string[] = [];
    if (ratios.singletonP95 > 1.10) rejectionReasons.push(`singleton p95 ${ratios.singletonP95}x > 1.10x GZIP`);
    if (ratios.singletonP99 > 1.15) rejectionReasons.push(`singleton p99 ${ratios.singletonP99}x > 1.15x GZIP`);
    if (ratios.producerCpu > 1.15) rejectionReasons.push(`producer CPU ${ratios.producerCpu}x > 1.15x GZIP`);
    if (ratios.consumerCpu > 1.15) rejectionReasons.push(`consumer CPU ${ratios.consumerCpu}x > 1.15x GZIP`);
    if (ratios.brokerCpu > 1.15) rejectionReasons.push(`broker CPU ${ratios.brokerCpu}x > 1.15x GZIP`);
    const infrastructureBytes = a.topicDiskBytes + a.brokerIngressBytes;
    const gzipInfrastructureBytes = g.topicDiskBytes + g.brokerIngressBytes;
    return {
      arm: result.arm.id,
      eligible: rejectionReasons.length === 0,
      ratiosToGzip: ratios,
      infrastructureBytes,
      infrastructureBytesRatioToGzip: ratio(infrastructureBytes, gzipInfrastructureBytes),
      totalCpuMsPerThousandEvents: round(
        a.producerCpuMsPerThousandEvents + a.consumerCpuMsPerThousandEvents + a.brokerCpuMsPerThousandEvents,
      ),
      rejectionReasons,
    };
  });

  const eligible = comparisons.filter((candidate) => candidate.eligible);
  eligible.sort((left, right) => {
    const bytesDelta = (left.infrastructureBytes - right.infrastructureBytes) / Math.max(right.infrastructureBytes, 1);
    if (Math.abs(bytesDelta) > 0.05) return left.infrastructureBytes - right.infrastructureBytes;
    return left.totalCpuMsPerThousandEvents - right.totalCpuMsPerThousandEvents;
  });

  return {
    selectedArm: eligible[0]?.arm ?? null,
    gzipBaseline: gzip.aggregate,
    comparisons,
    eligibleParetoOrder: eligible.map((candidate) => candidate.arm),
  };
}

function configureCodec(arm: Arm): void {
  if (arm.zstdLevel === undefined) delete process.env["REDPANDA_ZSTD_LEVEL"];
  else process.env["REDPANDA_ZSTD_LEVEL"] = String(arm.zstdLevel);
  process.env["REDPANDA_COMPRESSION"] = arm.codec;
  resolveRedpandaCompression(arm.codec);
}

function resolveArmCompression(arm: Arm): number {
  configureCodec(arm);
  return resolveRedpandaCompression(arm.codec).type as unknown as number;
}

async function startFreshBroker(): Promise<void> {
  stopBroker();
  docker([
    "run", "-d", "--name", CONTAINER_NAME,
    "-p", "19092:19092", "-p", "19644:9644",
    REDPANDA_IMAGE,
    "redpanda", "start",
    "--overprovisioned",
    "--smp", "1",
    "--memory", "1024M",
    "--reserve-memory", "0M",
    "--node-id", "0",
    "--check=false",
    "--kafka-addr", "internal://0.0.0.0:9092,external://0.0.0.0:19092",
    "--advertise-kafka-addr", "internal://127.0.0.1:9092,external://127.0.0.1:19092",
  ]);

  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      docker(["exec", CONTAINER_NAME, "rpk", "cluster", "health", "--exit-when-healthy"]);
      return;
    } catch {
      await sleep(1_000);
    }
  }
  docker(["logs", CONTAINER_NAME], { stdio: "inherit" });
  throw new Error("Redpanda benchmark broker did not become healthy");
}

function stopBroker(): void {
  try {
    docker(["rm", "-f", CONTAINER_NAME]);
  } catch {
    // Best-effort cleanup when the container is absent.
  }
}

function brokerCounters(): BrokerCounters {
  const cpuStat = dockerText(["exec", CONTAINER_NAME, "sh", "-lc", "awk '$1==\"usage_usec\" {print $2}' /sys/fs/cgroup/cpu.stat"]);
  const memory = dockerText(["exec", CONTAINER_NAME, "sh", "-lc", "cat /sys/fs/cgroup/memory.current"]);
  const rx = dockerText(["exec", CONTAINER_NAME, "sh", "-lc", "cat /sys/class/net/eth0/statistics/rx_bytes"]);
  const tx = dockerText(["exec", CONTAINER_NAME, "sh", "-lc", "cat /sys/class/net/eth0/statistics/tx_bytes"]);
  return {
    cpuUsec: Number(cpuStat),
    memoryBytes: Number(memory),
    rxBytes: Number(rx),
    txBytes: Number(tx),
  };
}

function syncBroker(): void {
  docker(["exec", CONTAINER_NAME, "sh", "-lc", "sync"]);
}

function topicDiskUsage(topic: string): number {
  const command = `if [ -d /var/lib/redpanda/data/kafka/${topic} ]; then du -sb /var/lib/redpanda/data/kafka/${topic} | awk '{print $1}'; else echo 0; fi`;
  return Number(dockerText(["exec", CONTAINER_NAME, "sh", "-lc", command]));
}

function docker(args: string[], options: { stdio?: "inherit" } = {}): Buffer {
  return execFileSync("docker", args, {
    encoding: null,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
}

function dockerText(args: string[]): string {
  return docker(args).toString("utf8").trim();
}

function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function expandPercentileApproximation(value: Percentiles): number[] {
  // Aggregation only needs a stable cross-scenario latency guardrail. Preserve
  // the shape anchors rather than pretending scenario p-values are raw samples.
  return [value.p50, value.p50, value.p50, value.p95, value.p99, value.max];
}

function percentile(sorted: number[], fraction: number): number {
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[rank] ?? 0;
}

function cpuMs(usage: NodeJS.CpuUsage): number {
  return (usage.user + usage.system) / 1_000;
}

function ratio(value: number, baseline: number): number {
  if (baseline <= 0) return value <= 0 ? 1 : Number.POSITIVE_INFINITY;
  return round(value / baseline, 4);
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function sanitizeTopic(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 220);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
