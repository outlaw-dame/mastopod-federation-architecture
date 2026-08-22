import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import kafkaJs from "kafkajs";
import { resolveRedpandaCompression } from "../src/streams/kafka-compression.js";

const { Kafka, logLevel } = kafkaJs;
const IMAGE = process.env["REDPANDA_RF3_IMAGE"] ?? "redpandadata/redpanda:v24.1.3";
const OUTPUT = process.env["REDPANDA_RF3_OUTPUT"] ?? "../measurements/redpanda-compression-rf3/summary.json";
const REPEATS = positive("REDPANDA_RF3_REPEATS", 3);
const MESSAGE_COUNT = positive("REDPANDA_RF3_MESSAGES", 4_000);
const LATENCY_COUNT = positive("REDPANDA_RF3_LATENCY_MESSAGES", 300);
const BATCH = positive("REDPANDA_RF3_BATCH", 100);
const NETWORK = "redpanda-compression-rf3";
const BROKERS = ["127.0.0.1:19092", "127.0.0.1:29092", "127.0.0.1:39092"];
const nodes = [
  { name: "rf3-redpanda-0", host: "redpanda-0", external: 19092, nodeId: 0 },
  { name: "rf3-redpanda-1", host: "redpanda-1", external: 29092, nodeId: 1 },
  { name: "rf3-redpanda-2", host: "redpanda-2", external: 39092, nodeId: 2 },
] as const;
const arms: readonly Arm[] = [
  { id: "gzip", codec: "gzip" },
  { id: "zstd-1", codec: "zstd", level: 1 },
  { id: "zstd-2", codec: "zstd", level: 2 },
  { id: "zstd-3", codec: "zstd", level: 3 },
];

type Arm = { id: string; codec: "gzip" | "zstd"; level?: number };
type Counters = { cpuUsec: number; memoryBytes: number; rxBytes: number; txBytes: number };
type P = { p50: number; p95: number; p99: number; max: number };
type Run = {
  repeat: number; arm: string; messages: number; rawBytes: number; totalTopicDiskBytes: number;
  producer: { wallMs: number; cpuMs: number; eventsPerSecond: number; batchAckMs: P; singletonAckMs: P };
  consumer: { wallMs: number; cpuMs: number; eventsPerSecond: number };
  cluster: { producerCpuMs: number; consumerCpuMs: number; producerNetworkBytes: number; consumerNetworkBytes: number; memoryBytesAfterProduce: number };
};

type Median = Omit<Run, "repeat"> & { repeats: number; totalCpuMsPerThousandEvents: number; diskBytesPerEvent: number; clusterNetworkBytesPerEvent: number };

void main();

async function main(): Promise<void> {
  mkdirSync(dir(OUTPUT), { recursive: true });
  docker(["pull", IMAGE]);
  const runs: Run[] = [];
  try {
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      for (const arm of arms) {
        console.log(`\n=== RF3 repeat ${repeat}/${REPEATS}; ${arm.id} ===`);
        configure(arm);
        await startCluster();
        await warmup(arm);
        runs.push(await measure(repeat, arm));
        stopCluster();
      }
    }
  } finally { stopCluster(); }

  const medians = arms.map((arm) => medianArm(arm.id, runs));
  const gzip = must(medians.find((entry) => entry.arm === "gzip"), "gzip");
  const comparisons = medians.map((entry) => ({
    arm: entry.arm,
    ratiosToGzip: {
      topicDisk: r(entry.totalTopicDiskBytes, gzip.totalTopicDiskBytes),
      clusterNetwork: r(entry.cluster.producerNetworkBytes + entry.cluster.consumerNetworkBytes, gzip.cluster.producerNetworkBytes + gzip.cluster.consumerNetworkBytes),
      producerCpu: r(entry.producer.cpuMs, gzip.producer.cpuMs),
      consumerCpu: r(entry.consumer.cpuMs, gzip.consumer.cpuMs),
      brokerCpu: r(entry.cluster.producerCpuMs + entry.cluster.consumerCpuMs, gzip.cluster.producerCpuMs + gzip.cluster.consumerCpuMs),
      totalCpu: r(entry.totalCpuMsPerThousandEvents, gzip.totalCpuMsPerThousandEvents),
      throughput: r(entry.producer.eventsPerSecond, gzip.producer.eventsPerSecond),
      singletonP95: r(entry.producer.singletonAckMs.p95, gzip.producer.singletonAckMs.p95),
      singletonP99: r(entry.producer.singletonAckMs.p99, gzip.producer.singletonAckMs.p99),
    },
  }));
  const candidates = comparisons.filter((entry) => entry.arm !== "gzip" && entry.ratiosToGzip.topicDisk <= 1.25 && entry.ratiosToGzip.clusterNetwork <= 1.25 && entry.ratiosToGzip.totalCpu <= 0.85 && entry.ratiosToGzip.singletonP95 <= 1.15 && entry.ratiosToGzip.singletonP99 <= 1.20);
  candidates.sort((a, b) => a.ratiosToGzip.totalCpu - b.ratiosToGzip.totalCpu || a.ratiosToGzip.clusterNetwork - b.ratiosToGzip.clusterNetwork);
  const summary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    redpandaImage: IMAGE,
    methodology: {
      brokers: 3,
      replicationFactor: 3,
      partitions: 6,
      acks: -1,
      repeats: REPEATS,
      messagesPerRepeat: MESSAGE_COUNT,
      singletonLatencyMessages: LATENCY_COUNT,
      batchSize: BATCH,
      freshClusterPerArmPerRepeat: true,
      isolatedWarmupTopic: true,
      networkMetric: "sum of RX+TX deltas across all three broker containers; this intentionally counts work at both endpoints and is used only for matched relative comparison",
    },
    runs,
    medians,
    comparisons,
    selectedArm: candidates[0]?.arm ?? "gzip",
  };
  writeFileSync(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ medians, comparisons, selectedArm: summary.selectedArm }, null, 2));
}

async function startCluster(): Promise<void> {
  stopCluster();
  try { docker(["network", "create", NETWORK]); } catch {}
  for (const node of nodes) {
    const args = ["run", "-d", "--name", node.name, "--network", NETWORK, "--network-alias", node.host, "-p", `${node.external}:${node.external}`, IMAGE,
      "redpanda", "start", "--overprovisioned", "--smp", "1", "--memory", "768M", "--reserve-memory", "0M", "--check=false", "--node-id", String(node.nodeId),
      "--rpc-addr", `0.0.0.0:33145`, "--advertise-rpc-addr", `${node.host}:33145`,
      "--kafka-addr", `internal://0.0.0.0:9092,external://0.0.0.0:${node.external}`,
      "--advertise-kafka-addr", `internal://${node.host}:9092,external://127.0.0.1:${node.external}`];
    if (node.nodeId !== 0) args.push("--seeds", "redpanda-0:33145");
    docker(args);
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const brokers = dockerText(["exec", nodes[0].name, "rpk", "cluster", "info"]);
      docker(["exec", nodes[0].name, "rpk", "cluster", "health", "--exit-when-healthy"]);
      const ids = [...brokers.matchAll(/\b\d+\b/g)].length;
      if (brokers.includes("redpanda-1") && brokers.includes("redpanda-2") || ids >= 3) return;
    } catch {}
    await sleep(500);
  }
  for (const node of nodes) { try { console.error(dockerText(["logs", node.name])); } catch {} }
  throw new Error("Three-broker Redpanda cluster did not become healthy");
}

function stopCluster(): void {
  for (const node of nodes) { try { docker(["rm", "-f", node.name]); } catch {} }
  try { docker(["network", "rm", NETWORK]); } catch {}
}

async function warmup(arm: Arm): Promise<void> {
  const kafka = client(`warmup-${arm.id}`);
  const admin = kafka.admin(); const producer = kafka.producer({ allowAutoTopicCreation: false });
  const topic = `rf3-warmup-${arm.id}-${randomUUID().slice(0, 8)}`;
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 3, replicationFactor: 3, configEntries: [{ name: "compression.type", value: "producer" }] }] });
  await producer.connect();
  const messages = mixedMessages(300);
  for (let i = 0; i < 3; i += 1) await producer.send({ topic, messages, compression: compression(arm), acks: -1 });
  await producer.disconnect(); await admin.deleteTopics({ topics: [topic] }); await admin.disconnect(); await sleep(500);
}

async function measure(repeat: number, arm: Arm): Promise<Run> {
  const kafka = client(`measure-${arm.id}-${repeat}`);
  const admin = kafka.admin(); const producer = kafka.producer({ allowAutoTopicCreation: false });
  const topic = `rf3-${arm.id}-${randomUUID().slice(0, 8)}`;
  const latencyTopic = `${topic}-latency`;
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: [topic, latencyTopic].map((name) => ({ topic: name, numPartitions: 6, replicationFactor: 3, configEntries: [{ name: "compression.type", value: "producer" }, { name: "cleanup.policy", value: "delete" }] })) });
  await producer.connect();
  const messages = mixedMessages(MESSAGE_COUNT);
  const rawBytes = messages.reduce((sum, message) => sum + Buffer.byteLength(message.value), 0);
  const codec = compression(arm);
  const before = clusterCounters(); const cpu0 = process.cpuUsage(); const t0 = performance.now(); const batchAck: number[] = [];
  for (let offset = 0; offset < messages.length; offset += BATCH) {
    const started = performance.now();
    await producer.send({ topic, messages: messages.slice(offset, offset + BATCH), compression: codec, acks: -1 });
    batchAck.push(performance.now() - started);
  }
  const wallMs = performance.now() - t0; const producerCpu = cpuMs(process.cpuUsage(cpu0)); const afterProduce = clusterCounters();
  const singleton = mixedMessages(LATENCY_COUNT, 900); const singletonAck: number[] = [];
  for (const message of singleton) { const started = performance.now(); await producer.send({ topic: latencyTopic, messages: [message], compression: codec, acks: -1 }); singletonAck.push(performance.now() - started); }
  await producer.disconnect(); await sleep(1_200); syncAll();
  const totalTopicDiskBytes = diskAll(topic) + diskAll(latencyTopic);

  const beforeConsume = clusterCounters(); const cpu1 = process.cpuUsage(); const consumeStart = performance.now();
  await consumeExactly(kafka, topic, MESSAGE_COUNT);
  const consumerWallMs = performance.now() - consumeStart; const consumerCpu = cpuMs(process.cpuUsage(cpu1)); const afterConsume = clusterCounters();
  await admin.deleteTopics({ topics: [topic, latencyTopic] }); await admin.disconnect();
  return {
    repeat, arm: arm.id, messages: MESSAGE_COUNT, rawBytes, totalTopicDiskBytes,
    producer: { wallMs: round(wallMs), cpuMs: round(producerCpu), eventsPerSecond: round(MESSAGE_COUNT / (wallMs / 1000)), batchAckMs: pct(batchAck), singletonAckMs: pct(singletonAck) },
    consumer: { wallMs: round(consumerWallMs), cpuMs: round(consumerCpu), eventsPerSecond: round(MESSAGE_COUNT / (consumerWallMs / 1000)) },
    cluster: {
      producerCpuMs: round((afterProduce.cpuUsec - before.cpuUsec) / 1000),
      consumerCpuMs: round((afterConsume.cpuUsec - beforeConsume.cpuUsec) / 1000),
      producerNetworkBytes: (afterProduce.rxBytes - before.rxBytes) + (afterProduce.txBytes - before.txBytes),
      consumerNetworkBytes: (afterConsume.rxBytes - beforeConsume.rxBytes) + (afterConsume.txBytes - beforeConsume.txBytes),
      memoryBytesAfterProduce: afterProduce.memoryBytes,
    },
  };
}

function medianArm(arm: string, runs: Run[]): Median {
  const items = runs.filter((run) => run.arm === arm); if (items.length !== REPEATS) throw new Error(`${arm}: expected ${REPEATS} repeats, got ${items.length}`);
  const m = <T extends number>(fn: (item: Run) => T) => median(items.map(fn));
  const messages = items[0]!.messages;
  const result = {
    repeats: REPEATS, arm, messages, rawBytes: m((x) => x.rawBytes), totalTopicDiskBytes: m((x) => x.totalTopicDiskBytes),
    producer: { wallMs: m((x) => x.producer.wallMs), cpuMs: m((x) => x.producer.cpuMs), eventsPerSecond: m((x) => x.producer.eventsPerSecond), batchAckMs: medianP(items.map((x) => x.producer.batchAckMs)), singletonAckMs: medianP(items.map((x) => x.producer.singletonAckMs)) },
    consumer: { wallMs: m((x) => x.consumer.wallMs), cpuMs: m((x) => x.consumer.cpuMs), eventsPerSecond: m((x) => x.consumer.eventsPerSecond) },
    cluster: { producerCpuMs: m((x) => x.cluster.producerCpuMs), consumerCpuMs: m((x) => x.cluster.consumerCpuMs), producerNetworkBytes: m((x) => x.cluster.producerNetworkBytes), consumerNetworkBytes: m((x) => x.cluster.consumerNetworkBytes), memoryBytesAfterProduce: m((x) => x.cluster.memoryBytesAfterProduce) },
  };
  const totalCpu = result.producer.cpuMs + result.consumer.cpuMs + result.cluster.producerCpuMs + result.cluster.consumerCpuMs;
  return { ...result, totalCpuMsPerThousandEvents: round(totalCpu / messages * 1000), diskBytesPerEvent: round(result.totalTopicDiskBytes / messages), clusterNetworkBytesPerEvent: round((result.cluster.producerNetworkBytes + result.cluster.consumerNetworkBytes) / messages) };
}

function mixedMessages(count: number, forcedBytes?: number) {
  return Array.from({ length: count }, (_, i) => {
    const selector = i % 10; const bodyBytes = forcedBytes ?? (selector < 5 ? 1_600 : selector < 7 ? 850 : selector < 9 ? 5_500 : 20_000);
    const actor = `https://pod.example/users/${i % 200}`; const content = body(bodyBytes, i);
    const value = JSON.stringify({ activity: { "@context": "https://www.w3.org/ns/activitystreams", id: `https://pod.example/activities/${i}`, type: selector < 7 && selector >= 5 ? (i % 2 ? "Like" : "Announce") : "Create", actor, object: selector < 7 && selector >= 5 ? `https://remote.example/objects/${i % 500}` : { id: `https://pod.example/objects/${i}`, type: selector === 9 ? "Article" : "Note", attributedTo: actor, content, attachment: selector >= 7 && selector < 9 ? Array.from({ length: 4 }, (_, n) => ({ type: "Document", mediaType: n % 2 ? "image/webp" : "image/avif", url: `https://media.example/${i}/${n}` })) : undefined }, to: ["https://www.w3.org/ns/activitystreams#Public"] }, actorUri: actor, origin: "local", meta: { isPublicActivity: true, isPublicIndexable: true, visibility: "public" } });
    return { key: actor, value, headers: { origin: "local", "activity-type": selector < 7 && selector >= 5 ? "interaction" : "Create" } };
  });
}

function body(bytes: number, seed: number): string { const words = ["federated","social","community","activitypub","portable","identity","timeline","distributed","privacy","protocol","performance","scalable","efficient","storage","latency","stream","event","pod"]; let out = ""; let x = seed + 1; while (Buffer.byteLength(out) < bytes) { x = (Math.imul(x ^ (x >>> 16), 0x45d9f3b) + 17) >>> 0; out += `${words[x % words.length]}-${x.toString(36)} `; } return out.slice(0, bytes); }
function client(id: string) { return new Kafka({ clientId: `rf3-compression-${id}`, brokers: BROKERS, connectionTimeout: 10_000, requestTimeout: 30_000, logLevel: logLevel.NOTHING, retry: { retries: 10, initialRetryTime: 100 } }); }
async function consumeExactly(kafka: InstanceType<typeof Kafka>, topic: string, expected: number): Promise<void> { const consumer = kafka.consumer({ groupId: `rf3-${randomUUID()}` }); await consumer.connect(); await consumer.subscribe({ topic, fromBeginning: true }); let seen = 0; await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`${topic}: ${seen}/${expected}`)), 60_000); void consumer.run({ eachBatch: async ({ batch }) => { seen += batch.messages.length; if (seen >= expected) { clearTimeout(timer); resolve(); } } }).catch(reject); }); await consumer.stop(); await consumer.disconnect(); if (seen !== expected) throw new Error(`${topic}: expected ${expected}, saw ${seen}`); }
function configure(arm: Arm): void { process.env["REDPANDA_COMPRESSION"] = arm.codec; if (arm.level === undefined) delete process.env["REDPANDA_ZSTD_LEVEL"]; else process.env["REDPANDA_ZSTD_LEVEL"] = String(arm.level); resolveRedpandaCompression(arm.codec); }
function compression(arm: Arm) { configure(arm); return resolveRedpandaCompression(arm.codec).type; }
function clusterCounters(): Counters { return nodes.map(counter).reduce((a, b) => ({ cpuUsec: a.cpuUsec + b.cpuUsec, memoryBytes: a.memoryBytes + b.memoryBytes, rxBytes: a.rxBytes + b.rxBytes, txBytes: a.txBytes + b.txBytes }), { cpuUsec: 0, memoryBytes: 0, rxBytes: 0, txBytes: 0 }); }
function counter(node: typeof nodes[number]): Counters { return { cpuUsec: Number(dockerText(["exec", node.name, "sh", "-c", "awk '/usage_usec/ {print $2}' /sys/fs/cgroup/cpu.stat"])), memoryBytes: Number(dockerText(["exec", node.name, "cat", "/sys/fs/cgroup/memory.current"])), rxBytes: Number(dockerText(["exec", node.name, "cat", "/sys/class/net/eth0/statistics/rx_bytes"])), txBytes: Number(dockerText(["exec", node.name, "cat", "/sys/class/net/eth0/statistics/tx_bytes"])) }; }
function diskAll(topic: string): number { return nodes.reduce((sum, node) => sum + Number(dockerText(["exec", node.name, "sh", "-c", `du -sb /var/lib/redpanda/data/kafka/${topic} 2>/dev/null | awk '{print $1+0}'`])), 0); }
function syncAll(): void { for (const node of nodes) { try { docker(["exec", node.name, "sync"]); } catch {} } }
function docker(args: string[]): string { const value = execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }); return value.trim(); }
function dockerText(args: string[]): string { return docker(args); }
function cpuMs(value: NodeJS.CpuUsage): number { return (value.user + value.system) / 1000; }
function pct(values: number[]): P { const s = [...values].sort((a,b)=>a-b); return { p50: round(q(s,.5)), p95: round(q(s,.95)), p99: round(q(s,.99)), max: round(s.at(-1) ?? 0) }; }
function q(s: number[], p: number): number { return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))] ?? 0; }
function medianP(values: P[]): P { return { p50: median(values.map((x)=>x.p50)), p95: median(values.map((x)=>x.p95)), p99: median(values.map((x)=>x.p99)), max: median(values.map((x)=>x.max)) }; }
function median(values: number[]): number { const s=[...values].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return round(s.length%2?s[m]!:(s[m-1]!+s[m]!)/2); }
function r(a: number,b: number): number { return round(b > 0 ? a/b : 0); }
function round(v: number): number { return Number(v.toFixed(6)); }
function positive(name: string, fallback: number): number { const n=Number.parseInt(process.env[name] ?? String(fallback),10); if(!Number.isInteger(n)||n<=0) throw new Error(`${name} must be positive`); return n; }
function must<T>(v:T|undefined,label:string):T { if(v===undefined) throw new Error(`Missing ${label}`); return v; }
function dir(path:string):string { const i=path.lastIndexOf("/"); return i<0?".":path.slice(0,i); }
function sleep(ms:number):Promise<void>{return new Promise((resolve)=>setTimeout(resolve,ms));}
