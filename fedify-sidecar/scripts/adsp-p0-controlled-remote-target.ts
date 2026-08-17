#!/usr/bin/env node

import { createControlledActivityPubTargetServer } from "../src/adsp/ControlledActivityPubTargetServer.js";

function parseNonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = parseNonNegativeInt(name, raw, fallback);
  if (value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

async function main(): Promise<void> {
  const host = process.env["ADSP_REMOTE_HOST"] || "127.0.0.1";
  const port = parsePositiveInt("ADSP_REMOTE_PORT", process.env["ADSP_REMOTE_PORT"], 18080);
  const maxBodyBytes = parsePositiveInt(
    "ADSP_REMOTE_MAX_BODY_BYTES",
    process.env["ADSP_REMOTE_MAX_BODY_BYTES"],
    1024 * 1024,
  );
  const transientFailuresBeforeSuccess = parseNonNegativeInt(
    "ADSP_REMOTE_TRANSIENT_FAILURES",
    process.env["ADSP_REMOTE_TRANSIENT_FAILURES"],
    2,
  );
  const maxObservations = parsePositiveInt(
    "ADSP_REMOTE_MAX_OBSERVATIONS",
    process.env["ADSP_REMOTE_MAX_OBSERVATIONS"],
    10_000,
  );

  const fixture = createControlledActivityPubTargetServer({
    host,
    port,
    maxBodyBytes,
    transientFailuresBeforeSuccess,
    maxObservations,
  });
  const info = await fixture.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await fixture.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixture: "ADSP-P0-controlled-remote",
    ...info,
    transientFailuresBeforeSuccess,
    maxBodyBytes,
    maxObservations,
  })}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
