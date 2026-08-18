#!/usr/bin/env node

import { createW3HostGatewayLoopbackProxy } from "../src/adsp/W3HostGatewayLoopbackProxy.js";

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`${name} must be a canonical positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) throw new Error(`${name} must be from 1 through 65535`);
  return value;
}

async function main(): Promise<void> {
  const bindPort = parsePort("ADSP_P2_W3_GATEWAY_PORT", process.env["ADSP_P2_W3_GATEWAY_PORT"], 18081);
  const upstreamPort = parsePort("ADSP_REMOTE_PORT", process.env["ADSP_REMOTE_PORT"], 18080);
  const proxy = createW3HostGatewayLoopbackProxy({ bindPort, upstreamPort });
  const info = await proxy.start();
  process.stdout.write(`${JSON.stringify({ ok: true, fixture: "ADSP-P2-W3-host-target-gateway", ...info })}\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await proxy.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
