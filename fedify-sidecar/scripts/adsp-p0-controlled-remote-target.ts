#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ADSP_CONTROLLED_REMOTE_SCENARIOS,
  ControlledActivityPubTargetState,
  isAdspControlledRemoteScenario,
  type AdspControlledRemoteScenario,
} from "../src/adsp/ControlledActivityPubTarget.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18080;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

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

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized).toString(),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(serialized);
}

async function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      request.destroy();
      throw new Error(`request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function baseUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
}

function actorDocument(
  origin: string,
  scenario: AdspControlledRemoteScenario,
): Record<string, unknown> {
  const actor = `${origin}/actor/${scenario}`;
  const inbox = `${origin}/inbox/${scenario}`;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: actor,
    type: "Person",
    preferredUsername: `adsp-${scenario}`,
    inbox,
    endpoints: { sharedInbox: inbox },
  };
}

function routeScenario(pathname: string, prefix: string): AdspControlledRemoteScenario | null {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length);
  return isAdspControlledRemoteScenario(value) ? value : null;
}

async function main(): Promise<void> {
  const host = process.env["ADSP_REMOTE_HOST"] || DEFAULT_HOST;
  const port = parsePositiveInt("ADSP_REMOTE_PORT", process.env["ADSP_REMOTE_PORT"], DEFAULT_PORT);
  const maxBodyBytes = parsePositiveInt(
    "ADSP_REMOTE_MAX_BODY_BYTES",
    process.env["ADSP_REMOTE_MAX_BODY_BYTES"],
    DEFAULT_MAX_BODY_BYTES,
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
  const origin = baseUrl(host, port);
  const state = new ControlledActivityPubTargetState({
    transientFailuresBeforeSuccess,
    maxObservations,
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", origin);

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { ok: true, fixture: "ADSP-P0-controlled-remote" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/stats") {
        writeJson(response, 200, state.snapshot());
        return;
      }

      if (request.method === "POST" && url.pathname === "/reset") {
        state.reset();
        writeJson(response, 200, { ok: true });
        return;
      }

      const actorScenario = routeScenario(url.pathname, "/actor/");
      if (request.method === "GET" && actorScenario) {
        writeJson(response, 200, actorDocument(origin, actorScenario), {
          "content-type": "application/activity+json; charset=utf-8",
        });
        return;
      }

      const inboxScenario = routeScenario(url.pathname, "/inbox/");
      if (inboxScenario) {
        const body = await readBoundedBody(request, maxBodyBytes);
        const result = state.handle({
          scenario: inboxScenario,
          method: request.method || "UNKNOWN",
          path: url.pathname,
          headers: request.headers,
          body,
        });
        writeJson(response, result.statusCode, JSON.parse(result.body), result.headers);
        return;
      }

      writeJson(response, 404, {
        error: "not_found",
        scenarios: ADSP_CONTROLLED_REMOTE_SCENARIOS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) writeJson(response, 413, { error: "request_rejected", message });
      else response.destroy();
    }
  });

  const shutdown = () => {
    server.close(error => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixture: "ADSP-P0-controlled-remote",
    origin,
    host,
    port,
    transientFailuresBeforeSuccess,
    maxBodyBytes,
    maxObservations,
    actors: Object.fromEntries(
      ADSP_CONTROLLED_REMOTE_SCENARIOS.map(scenario => [scenario, `${origin}/actor/${scenario}`]),
    ),
  })}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
