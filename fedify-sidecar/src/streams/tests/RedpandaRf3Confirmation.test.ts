import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const confirmation = resolve("scripts/confirm-redpanda-compression-rf3.mjs");

function campaign(directory: string, id: number, eligible: boolean) {
  const file = join(directory, `campaign-${id}.json`);
  writeFileSync(file, JSON.stringify({
    schema: "apdm.redpanda.rf3-production-validation.v2",
    productionArm: "zstd-1",
    productionArmEligible: eligible,
    selectedCandidateArm: eligible ? "zstd-1" : "zstd-2",
    campaign: { id, runId: "123", runAttempt: "1" },
    zstd1: {
      eligible,
      reasons: eligible ? [] : ["singleton p99 absolute delta 0.563 ms > 0.5 ms"],
      ratiosToGzip: { singletonP99: eligible ? 0.91 : 1.53 },
      absoluteTailDeltaMs: { p99: eligible ? -0.12 : 0.563 },
    },
  }));
  return file;
}

function fixture(eligibility: boolean[]) {
  const directory = mkdtempSync(join(tmpdir(), "rf3-confirmation-"));
  directories.push(directory);
  return {
    inputs: eligibility.map((eligible, index) => campaign(directory, index + 1, eligible)),
    output: join(directory, "decision.json"),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RF3 independent campaign confirmation", () => {
  it("retains one breach without rejecting production", () => {
    const { inputs, output } = fixture([false, true, true]);
    execFileSync(process.execPath, [confirmation, ...inputs, `--output=${output}`]);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      campaignCount: 3,
      confirmationThreshold: 2,
      breachCount: 1,
      confirmedRegression: false,
      productionArmEligible: true,
    });
  });

  it("confirms a production regression after two unchanged-gate breaches", () => {
    const { inputs, output } = fixture([false, true, false]);
    execFileSync(process.execPath, [confirmation, ...inputs, `--output=${output}`]);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      breachCount: 2,
      confirmedRegression: true,
      productionArmEligible: false,
    });
  });

  it("fails closed when campaign identities are duplicated", () => {
    const { inputs, output } = fixture([true, true, true]);
    const duplicate = JSON.parse(readFileSync(inputs[1]!, "utf8"));
    duplicate.campaign.id = 1;
    writeFileSync(inputs[1]!, JSON.stringify(duplicate));
    const result = spawnSync(process.execPath, [confirmation, ...inputs, `--output=${output}`], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("campaign identities are not independent");
  });

  it("fails closed when a validation contradicts its Zstd-1 comparison", () => {
    const { inputs, output } = fixture([true, true, true]);
    const contradictory = JSON.parse(readFileSync(inputs[2]!, "utf8"));
    contradictory.zstd1.eligible = false;
    writeFileSync(inputs[2]!, JSON.stringify(contradictory));
    const result = spawnSync(process.execPath, [confirmation, ...inputs, `--output=${output}`], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("eligibility disagrees");
  });
});
