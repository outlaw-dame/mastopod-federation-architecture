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

  // These gates are deliberately both relative and absolute. On this RF3 path
  // the GZIP singleton baseline is around one millisecond, so a percentage-only
  // p99 guard can reject a few tenths of a millisecond while accepting a much
  // larger CPU/storage bill. We still cap the relative tail and also require
  // the absolute p99 increase to remain <=0.5 ms.
  if (r.topicDisk > 1.05) reasons.push(`topic disk ${r.topicDisk}x > 1.05x GZIP`);
  if (r.clusterNetwork > 1.05) reasons.push(`cluster network ${r.clusterNetwork}x > 1.05x GZIP`);
  if (r.totalCpu > 0.90) reasons.push(`total CPU ${r.totalCpu}x > 0.90x GZIP`);
  if (r.throughput < 1.25) reasons.push(`producer throughput ${r.throughput}x < 1.25x GZIP`);
  if (r.singletonP95 > 1.15) reasons.push(`singleton p95 ${r.singletonP95}x > 1.15x GZIP`);
  if (r.singletonP99 > 1.25) reasons.push(`singleton p99 ${r.singletonP99}x > 1.25x GZIP`);
  if (p99DeltaMs > 0.5) reasons.push(`singleton p99 absolute delta ${p99DeltaMs.toFixed(3)} ms > 0.5 ms`);

  return {
    arm: entry.arm,
    eligible: entry.arm === "gzip" ? true : reasons.length === 0,
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
  // First protect tail latency, then minimize total compute, then bytes.
  const aMedian = summary.medians.find((entry) => entry.arm === a.arm);
  const bMedian = summary.medians.find((entry) => entry.arm === b.arm);
  return (
    aMedian.producer.singletonAckMs.p99 - bMedian.producer.singletonAckMs.p99 ||
    a.ratiosToGzip.totalCpu - b.ratiosToGzip.totalCpu ||
    (a.ratiosToGzip.topicDisk + a.ratiosToGzip.clusterNetwork) -
      (b.ratiosToGzip.topicDisk + b.ratiosToGzip.clusterNetwork)
  );
});

const selectedArm = eligibleZstd[0]?.arm ?? "gzip";
const decision = {
  version: 1,
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
    ordering: "lowest eligible singleton p99, then lowest total CPU, then lowest combined disk+network ratio",
  },
  comparisons,
};

fs.writeFileSync(output, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
console.log(JSON.stringify(decision, null, 2));

function required(value, label) {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}
