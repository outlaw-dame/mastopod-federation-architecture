import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const inputs = process.argv.slice(2).filter((arg) => !arg.startsWith("--output="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const output = outputArg?.slice("--output=".length) ?? "../measurements/redpanda-compression/decision.json";

if (inputs.length < 3) {
  throw new Error(`Expected at least 3 independent benchmark summaries, got ${inputs.length}`);
}

const trials = inputs.map((path) => JSON.parse(readFileSync(path, "utf8")));
const expectedArms = ["none", "gzip", "zstd--1", "zstd-1", "zstd-2", "zstd-3", "zstd-4", "zstd-6"];

for (const [index, trial] of trials.entries()) {
  const observed = trial.arms.map((entry) => entry.arm.id);
  if (JSON.stringify(observed) !== JSON.stringify(expectedArms)) {
    throw new Error(`Trial ${index + 1} has unexpected arms: ${JSON.stringify(observed)}`);
  }
}

const armResults = expectedArms.map((armId) => analyzeArm(armId));
const gzip = armResults.find((entry) => entry.arm === "gzip");
if (!gzip) throw new Error("GZIP baseline missing");

const eligible = armResults.filter((entry) => entry.eligible);
const efficientAlternatives = eligible.filter((entry) =>
  entry.arm !== "gzip" &&
  entry.arm !== "none" &&
  entry.medians.infrastructureBytesRatioToGzip <= 1.25 &&
  entry.medians.totalCpuRatioToGzip <= 0.75 &&
  entry.medians.throughputRatioToGzip >= 1.25
);

efficientAlternatives.sort((left, right) => {
  const leftPenalty = left.medians.infrastructureBytesRatioToGzip;
  const rightPenalty = right.medians.infrastructureBytesRatioToGzip;
  if (Math.abs(leftPenalty - rightPenalty) > 0.05) return leftPenalty - rightPenalty;
  if (left.medians.totalCpuRatioToGzip !== right.medians.totalCpuRatioToGzip) {
    return left.medians.totalCpuRatioToGzip - right.medians.totalCpuRatioToGzip;
  }
  return right.medians.throughputRatioToGzip - left.medians.throughputRatioToGzip;
});

const selected = efficientAlternatives[0] ?? gzip;
const decision = {
  version: 1,
  generatedAt: new Date().toISOString(),
  trialCount: trials.length,
  methodology: {
    baseline: "gzip",
    eligibility: {
      medianWorstScenarioP95RatioMax: 1.10,
      worstTrialWorstScenarioP95RatioMax: 1.25,
      medianWorstScenarioP99RatioMax: 1.15,
      worstTrialWorstScenarioP99RatioMax: 1.30,
      medianProducerCpuRatioMax: 1.15,
      medianConsumerCpuRatioMax: 1.15,
      medianBrokerCpuRatioMax: 1.15,
      worstTrialCpuRatioMax: 1.30,
    },
    promotionFromGzip: {
      infrastructureBytesRatioMax: 1.25,
      totalCpuRatioMax: 0.75,
      throughputRatioMin: 1.25,
      rationale: "A non-GZIP codec must remain within 25% of GZIP's broker-ingress+topic-disk footprint while saving at least 25% total measured CPU and improving producer throughput by at least 25%, in addition to latency/CPU safety gates.",
    },
    latencyAggregation: "For each trial and arm, compare each singleton payload class p95/p99 against the matching GZIP payload class, then use the worst scenario. This avoids the invalid practice of deriving global percentiles from already-aggregated percentiles.",
  },
  selectedArm: selected.arm,
  selectedMedians: selected.medians,
  arms: armResults,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
console.log(JSON.stringify(decision, null, 2));

function analyzeArm(armId) {
  const trialMetrics = trials.map((trial) => {
    const arm = trial.arms.find((entry) => entry.arm.id === armId);
    const trialGzip = trial.arms.find((entry) => entry.arm.id === "gzip");
    if (!arm || !trialGzip) throw new Error(`Missing ${armId} or gzip in a trial`);

    const a = arm.aggregate;
    const g = trialGzip.aggregate;
    const singletonArm = arm.scenarios.filter((entry) => entry.scenario.mode === "singleton");
    const singletonGzip = trialGzip.scenarios.filter((entry) => entry.scenario.mode === "singleton");

    const p95Ratios = singletonArm.map((entry) => {
      const baseline = singletonGzip.find((candidate) => candidate.scenario.id === entry.scenario.id);
      if (!baseline) throw new Error(`Missing GZIP singleton baseline for ${entry.scenario.id}`);
      return ratio(entry.producer.ackLatencyMs.p95, baseline.producer.ackLatencyMs.p95);
    });
    const p99Ratios = singletonArm.map((entry) => {
      const baseline = singletonGzip.find((candidate) => candidate.scenario.id === entry.scenario.id);
      if (!baseline) throw new Error(`Missing GZIP singleton baseline for ${entry.scenario.id}`);
      return ratio(entry.producer.ackLatencyMs.p99, baseline.producer.ackLatencyMs.p99);
    });

    const armTotalCpu = a.producerCpuMsPerThousandEvents + a.consumerCpuMsPerThousandEvents + a.brokerCpuMsPerThousandEvents;
    const gzipTotalCpu = g.producerCpuMsPerThousandEvents + g.consumerCpuMsPerThousandEvents + g.brokerCpuMsPerThousandEvents;
    const armInfrastructure = a.topicDiskBytes + a.brokerIngressBytes;
    const gzipInfrastructure = g.topicDiskBytes + g.brokerIngressBytes;

    return {
      worstScenarioP95Ratio: Math.max(...p95Ratios),
      worstScenarioP99Ratio: Math.max(...p99Ratios),
      producerCpuRatio: ratio(a.producerCpuMsPerThousandEvents, g.producerCpuMsPerThousandEvents),
      consumerCpuRatio: ratio(a.consumerCpuMsPerThousandEvents, g.consumerCpuMsPerThousandEvents),
      brokerCpuRatio: ratio(a.brokerCpuMsPerThousandEvents, g.brokerCpuMsPerThousandEvents),
      totalCpuRatioToGzip: ratio(armTotalCpu, gzipTotalCpu),
      infrastructureBytesRatioToGzip: ratio(armInfrastructure, gzipInfrastructure),
      throughputRatioToGzip: ratio(a.throughputEventsPerSecond, g.throughputEventsPerSecond),
      diskBytesPerRawByte: a.diskBytesPerRawByte,
      ingressBytesPerRawByte: a.ingressBytesPerRawByte,
      throughputEventsPerSecond: a.throughputEventsPerSecond,
      producerCpuMsPerThousandEvents: a.producerCpuMsPerThousandEvents,
      consumerCpuMsPerThousandEvents: a.consumerCpuMsPerThousandEvents,
      brokerCpuMsPerThousandEvents: a.brokerCpuMsPerThousandEvents,
    };
  });

  const medians = mapMedian(trialMetrics);
  const maxima = mapMax(trialMetrics);
  const rejectionReasons = [];

  if (medians.worstScenarioP95Ratio > 1.10) rejectionReasons.push(`median worst-scenario p95 ${medians.worstScenarioP95Ratio}x > 1.10x GZIP`);
  if (maxima.worstScenarioP95Ratio > 1.25) rejectionReasons.push(`worst-trial p95 ${maxima.worstScenarioP95Ratio}x > 1.25x GZIP`);
  if (medians.worstScenarioP99Ratio > 1.15) rejectionReasons.push(`median worst-scenario p99 ${medians.worstScenarioP99Ratio}x > 1.15x GZIP`);
  if (maxima.worstScenarioP99Ratio > 1.30) rejectionReasons.push(`worst-trial p99 ${maxima.worstScenarioP99Ratio}x > 1.30x GZIP`);
  for (const key of ["producerCpuRatio", "consumerCpuRatio", "brokerCpuRatio"]) {
    if (medians[key] > 1.15) rejectionReasons.push(`median ${key} ${medians[key]}x > 1.15x GZIP`);
    if (maxima[key] > 1.30) rejectionReasons.push(`worst-trial ${key} ${maxima[key]}x > 1.30x GZIP`);
  }

  return {
    arm: armId,
    eligible: rejectionReasons.length === 0,
    medians,
    maxima,
    trials: trialMetrics,
    rejectionReasons,
  };
}

function mapMedian(rows) {
  const keys = Object.keys(rows[0]);
  return Object.fromEntries(keys.map((key) => [key, round(median(rows.map((row) => row[key])))]));
}

function mapMax(rows) {
  const keys = Object.keys(rows[0]);
  return Object.fromEntries(keys.map((key) => [key, round(Math.max(...rows.map((row) => row[key])))]));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0) {
    throw new Error(`Invalid ratio inputs: value=${value}, baseline=${baseline}`);
  }
  return value / baseline;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
