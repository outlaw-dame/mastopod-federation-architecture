#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const isProduction = (process.env.NODE_ENV || "").toLowerCase() === "production";
const enforceGovernance = process.env.REDPANDA_ENFORCE_TOPIC_GOVERNANCE !== "false";

if (!isProduction) {
  process.stdout.write("[prestart] topic governance check skipped (NODE_ENV is not production)\n");
  process.exit(0);
}

if (!enforceGovernance) {
  process.stdout.write("[prestart] topic governance check skipped (REDPANDA_ENFORCE_TOPIC_GOVERNANCE=false)\n");
  process.exit(0);
}

if (!process.env.REDPANDA_TOPIC_BOOTSTRAP_PROFILE) {
  process.env.REDPANDA_TOPIC_BOOTSTRAP_PROFILE = "production";
}

process.stdout.write(
  `[prestart] verifying Redpanda topic governance (profile=${process.env.REDPANDA_TOPIC_BOOTSTRAP_PROFILE})\n`,
);

const npmExec = process.platform === "win32" ? "npm.cmd" : "npm";
const verify = spawnSync(
  npmExec,
  ["run", "topics:verify"],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (verify.status !== 0) {
  process.stderr.write("[prestart] Redpanda topic governance verification failed. Startup aborted.\n");
  process.exit(verify.status || 1);
}

process.stdout.write("[prestart] Redpanda topic governance verification passed.\n");
