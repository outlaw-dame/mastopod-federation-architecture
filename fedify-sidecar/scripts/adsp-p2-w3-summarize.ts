#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadBoundedAdspJsonFile } from "../src/adsp/BoundedJsonFile.js";
import {
  ADSP_P2_W3_REPLICA_COUNTS,
  ADSP_P2_W3_SCENARIOS,
  summarizeAdspP2W3Evidence,
  type AdspP2W3CaseEvidence,
} from "../src/adsp/P2W3EvidenceSummary.js";

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length !== 1) {
    throw new Error("usage: adsp-p2-w3-summarize <evidence-root>");
  }
  const root = resolve(argv[0]!);
  const cases: AdspP2W3CaseEvidence[] = [];
  for (const replicas of ADSP_P2_W3_REPLICA_COUNTS) {
    for (const scenario of ADSP_P2_W3_SCENARIOS) {
      const caseRoot = join(root, `${replicas}r`, scenario);
      const [origin, correlation, settlement] = await Promise.all([
        loadBoundedAdspJsonFile(join(caseRoot, "origin.json"), { label: `${replicas}r/${scenario} origin` }),
        loadBoundedAdspJsonFile(join(caseRoot, "correlation.json"), { label: `${replicas}r/${scenario} correlation` }),
        loadBoundedAdspJsonFile(join(caseRoot, "settlement.json"), { label: `${replicas}r/${scenario} settlement` }),
      ]);
      cases.push({ replicas, scenario, origin, correlation, settlement });
    }
  }
  const summary = summarizeAdspP2W3Evidence(cases);
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  await writeFile(join(root, "summary.json"), output, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(output);
}

main(process.argv.slice(2)).catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[ADSP-P2-W3] ${message}\n`);
  process.exitCode = 1;
});
