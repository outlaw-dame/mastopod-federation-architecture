#!/usr/bin/env node

import { createP2W3HostGatewayProxy } from "../src/adsp/P2W3HostGatewayProxy.js";

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new TypeError(`${name} must be a canonical positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) throw new TypeError(`${name} must be from 1 through 65535`);
  return value;
}

async function main(): Promise<void> {
  const targetGateway = createP2W3HostGatewayProxy({
    bindPort: port("ADSP_P2_W3_TARGET_GATEWAY_PORT", 18081),
    upstreamPort: port("ADSP_P2_W3_TARGET_UPSTREAM_PORT", 18080),
  });
  const sidecarGateway = createP2W3HostGatewayProxy({
    bindPort: port("ADSP_P2_W3_SIDECAR_GATEWAY_PORT", 18082),
    upstreamPort: port("ADSP_P2_W3_SIDECAR_UPSTREAM_PORT", 8080),
  });

  await targetGateway.start();
  try {
    await sidecarGateway.start();
  } catch (error) {
    await targetGateway.close();
    throw error;
  }

  process.stdout.write(
    `[ADSP-P2-W3] host gateways ready target=${port("ADSP_P2_W3_TARGET_GATEWAY_PORT", 18081)} sidecar=${port("ADSP_P2_W3_SIDECAR_GATEWAY_PORT", 18082)}\n`,
  );

  let closing = false;
  const close = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([targetGateway.close(), sidecarGateway.close()]);
    process.exit(code);
  };
  process.once("SIGTERM", () => void close(143));
  process.once("SIGINT", () => void close(130));
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[ADSP-P2-W3] ${message}\n`);
  process.exitCode = 1;
});
