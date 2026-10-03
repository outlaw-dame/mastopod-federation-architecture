import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const analyzer = resolve("scripts/analyze-redpanda-compression-rf3.mjs");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rf3-analyzer-"));
  directories.push(directory);
  const input = join(directory, "summary.json");
  const output = join(directory, "decision.json");
  const arms = ["gzip", "zstd-1", "zstd-2", "zstd-3"];
  const summary = {
    version: 2,
    methodology: {
      brokers: 3,
      replicationFactor: 3,
      repeats: 4,
      latinSquareArmOrder: true,
      pairedRatiosWithinRepeat: true,
    },
    medians: arms.map(arm => ({ arm, producer: { singletonAckMs: { p99: 1 } } })),
    comparisons: arms.map(arm => ({
      arm,
      ratiosToGzip: arm === "gzip"
        ? { topicDisk: 1, clusterNetwork: 1, producerCpu: 1, consumerCpu: 1, brokerCpu: 1, totalCpu: 1, throughput: 1, singletonP95: 1, singletonP99: 1 }
        : { topicDisk: 0.9, clusterNetwork: 0.9, producerCpu: 0.8, consumerCpu: 0.8, brokerCpu: 0.8, totalCpu: arm === "zstd-2" ? 0.7 : 0.8, throughput: 1.5, singletonP95: 1.05, singletonP99: 1.1 },
      absoluteTailDeltaMs: { p95: 0.05, p99: 0.1 },
    })),
  };
  return { input, output, summary };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RF3 compression analyzer methodology authority", () => {
  it("accepts only paired Latin-square evidence and selects the eligible resource leader", () => {
    const { input, output, summary } = fixture();
    writeFileSync(input, JSON.stringify(summary));
    execFileSync(process.execPath, [analyzer], {
      env: { ...process.env, REDPANDA_RF3_INPUT: input, REDPANDA_RF3_DECISION_OUTPUT: output },
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ version: 2, selectedArm: "zstd-2" });
  });

  it("fails closed when fixed-order or unpaired benchmark evidence is supplied", () => {
    const { input, output, summary } = fixture();
    summary.methodology.latinSquareArmOrder = false;
    writeFileSync(input, JSON.stringify(summary));
    const result = spawnSync(process.execPath, [analyzer], {
      env: { ...process.env, REDPANDA_RF3_INPUT: input, REDPANDA_RF3_DECISION_OUTPUT: output },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RF3 methodology contract drift");
  });

  it("fails closed when paired evidence contains a missing or non-numeric metric", () => {
    const { input, output, summary } = fixture();
    summary.comparisons[1]!.ratiosToGzip.throughput = Number.NaN;
    writeFileSync(input, JSON.stringify(summary));
    const result = spawnSync(process.execPath, [analyzer], {
      env: { ...process.env, REDPANDA_RF3_INPUT: input, REDPANDA_RF3_DECISION_OUTPUT: output },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid zstd-1 throughput ratio");
  });
});
