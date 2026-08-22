import fs from "node:fs";

const input = process.env.REDPANDA_RF3_INPUT ?? "../measurements/redpanda-compression-rf3/summary.json";
const output = process.env.REDPANDA_RF3_DECISION_OUTPUT ?? "../measurements/redpanda-compression-rf3/decision.json";
const summary = JSON.parse(fs.readFileSync(input, "utf8"));

if (summary.version !== 1) throw new Error(`Unsupported RF3 summary version ${summary.version}`);
if (summary.methodology?.brokers !== 3 || summary.methodology?.replicationFactor !== 3 || summary.methodology?.repeats !== 3) {
  throw new Error("RF3 methodology contract drift");
}

const expected = ["gzip", "zstd-1", "zstd-2", "zstd-3"];
if (JSON.stringify(summary.medians?.map((entry) => entry.arm)) !== JSON.stringify(expected)) {
  throw new Error(`RF3 arm drift: ${JSON.stringify(summary.medians?.map((entry) => entry.arm))}`);
}

const gzip = required(summary.medians.find((entry) => entry.arm === "gzip"), "gzip median");
const comparisons = summary.comparisons.map((entry) => {
  const median = required(summary.medians.find((candidate) => candidate.arm === entry.arm), `${entry.arm} median`);
  const r = entry.ratiosToGzip;
  const p99DeltaMs = median.producer.singletonAckMs.p99 - gzip.producer.singletonAckMs.p99;
  const p95DeltaMs = median.producer.singletonAckMs.p95 - gzip.producer.singletonAckMs.p95;
  const reasons = [];

  // Tail latency is a hard eligibility condition, not the primary optimizer.
  // Once a codec is inside both relative and absolute latency bounds, persistent
  // CPU and infrastructure cost determine the balanced production operating
  // point. This avoids allowing sub-millisecond runner noise to override a
  // durable compute penalty.
  if (entry.arm !== "gzip") {
    if (r.topicDisk > 1.05) reasons.push(`topic disk ${r.topicDisk}x > 1.05x GZIP`);
    if (r.clusterNetwork > 1.05) reasons.push(`cluster network ${r.clusterNetwork}x > 1.05x GZIP`);
    if (r.totalCpu > 0.90) reasons.push(`total CPU ${r.totalCpu}x > 0.90x GZIP`);
    if (r.throughput < 1.25) reasons.push(`producer throughput ${r.throughput}x < 1.25x GZIP`);
    if (r.singletonP95 > 1.15) reasons.push(`singleton p95 ${r.singletonP95}x > 1.15x GZIP`);
    if (r.singletonP99 > 1.25) reasons.push(`singleton p99 ${r.singletonP99}x > 1.25x GZIP`);
    if (p99DeltaMs > 0.5) reasons.push(`singleton p99 absolute delta ${p99DeltaMs.toFixed(3)} ms > 0.5 ms`);
  }

  return {
    arm: entry.arm,
    eligible: reasons.length === 0,
    reasons,
    ratiosToGzip: r,
    absoluteTailDeltaMs: {
      p95: Number(p95DeltaMs.toFixed(6)),
      p99: Number(p99DeltaMs.toFixed(6)),
    },
  };
});

const eligibleZstd = comparisons.filter((entry) => entry.arm.startsWith("zstd-") && entry.eligible);
eligibleZstd.sort((a, b) => {
  const aMedian = required(summary.medians.find((entry) => entry.arm === a.arm), `${a.arm} median`);
  const bMedian = required(summary.medians.find((entry) => entry.arm === b.arm), `${b.arm} median`);
  const aInfrastructure = a.ratiosToGzip.topicDisk + a.ratiosToGzip.clusterNetwork;
  const bInfrastructure = b.ratiosToGzip.topicDisk + b.ratiosToGzip.clusterNetwork;
  return (
    a.ratiosToGzip.totalCpu - b.ratiosToGzip.totalCpu ||
    aInfrastructure - bInfrastructure ||
    b.ratiosToGzip.throughput - a.ratiosToGzip.throughput ||
    aMedian.producer.singletonAckMs.p99 - bMedian.producer.singletonAckMs.p99
  );
});

const selectedArm = eligibleZstd[0]?.arm ?? "gzip";
const decision = {
  version: 2,
  generatedAt: new Date().toISOString(),
  selectedArm,
  policy: {
    topicDiskMaxRatioToGzip: 1.05,
    clusterNetworkMaxRatioToGzip: 1.05,
    totalCpuMaxRatioToGzip: 0.90,
    producerThroughputMinRatioToGzip: 1.25,
    singletonP95MaxRatioToGzip: 1.15,
    singletonP99MaxRatioToGzip: 1.25,
    singletonP99MaxAbsoluteIncreaseMs: 0.5,
    ordering: "after all safety gates pass: lowest total CPU, then lowest combined disk+network ratio, then highest throughput, then lowest singleton p99",
  },
  comparisons,
};

fs.writeFileSync(output, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
console.log(JSON.stringify(decision, null, 2));

function required(value, label) {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}
