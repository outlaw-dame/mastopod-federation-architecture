#!/usr/bin/env node

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runActivityPodsRemoteOriginCli } from "../src/adsp/RemoteFixtureActivityPodsOriginCli.js";

const execFileAsync = promisify(execFile);
const storagePreflight = fileURLToPath(
  new URL("../src/adsp/ci/verify-ap-federation-storage.sh", import.meta.url),
);

async function verifyActivityPodsStorage(): Promise<void> {
  await execFileAsync("bash", [storagePreflight], {
    env: {
      ...process.env,
      FUSEKI_URL: process.env["ADSP_ACTIVITYPODS_FUSEKI_URL"] ?? "http://localhost:3040",
    },
  });
}

verifyActivityPodsStorage()
  .then(() => runActivityPodsRemoteOriginCli(process.argv.slice(2), process.env))
  .then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  });