import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  ADSP_CONTROLLED_REMOTE_SCENARIOS,
  ControlledActivityPubTargetState,
  isAdspControlledRemoteScenario,
  type AdspControlledRemoteScenario,
  type ControlledTargetSnapshot,
} from "./ControlledActivityPubTarget.js";

export interface ControlledActivityPubTargetServerOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  transientFailuresBeforeSuccess?: number;
  maxObservations?: number;
}

export interface ControlledActivityPubTargetServerInfo {
  origin: string;
  host: string;
  port: number;
  actors: Record<AdspControlledRemoteScenario, string>;
}

export interface ControlledActivityPubTargetServer {
  start(): Promise<ControlledActivityPubTargetServerInfo>;
  close(): Promise<void>;
  reset(): void;
  snapshot(): ControlledTargetSnapshot;
  readonly server: Server;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18080;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function assertPort(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError("port must be a safe integer from 0 through 65535");
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
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

async function readBoundedBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new RangeError(`request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
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

function routeScenario(
  pathname: string,
  prefix: string,
): AdspControlledRemoteScenario | null {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length);
  return isAdspControlledRemoteScenario(value) ? value : null;
}

function listeningInfo(server: Server, configuredHost: string): ControlledActivityPubTargetServerInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("controlled ActivityPub target did not expose a TCP address");
  }
  const info = address as AddressInfo;
  const publicHost = configuredHost === "0.0.0.0" || configuredHost === "::"
    ? "127.0.0.1"
    : configuredHost;
  const origin = `http://${publicHost.includes(":") ? `[${publicHost}]` : publicHost}:${info.port}`;
  return {
    origin,
    host: configuredHost,
    port: info.port,
    actors: Object.fromEntries(
      ADSP_CONTROLLED_REMOTE_SCENARIOS.map(scenario => [
        scenario,
        `${origin}/actor/${scenario}`,
      ]),
    ) as Record<AdspControlledRemoteScenario, string>,
  };
}

export function createControlledActivityPubTargetServer(
  options: ControlledActivityPubTargetServerOptions = {},
): ControlledActivityPubTargetServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  assertPort(port);
  assertPositiveSafeInteger("maxBodyBytes", maxBodyBytes);

  const state = new ControlledActivityPubTargetState({
    transientFailuresBeforeSuccess: options.transientFailuresBeforeSuccess,
    maxObservations: options.maxObservations,
  });
  let info: ControlledActivityPubTargetServerInfo | null = null;
  let started = false;

  const server = createServer(async (request, response) => {
    try {
      if (!info) {
        writeJson(response, 503, { error: "fixture_not_ready" });
        return;
      }
      const url = new URL(request.url || "/", info.origin);

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          ok: true,
          fixture: "ADSP-P0-controlled-remote",
        });
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
        writeJson(response, 200, actorDocument(info.origin, actorScenario), {
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
        writeJson(
          response,
          result.statusCode,
          JSON.parse(result.body) as unknown,
          result.headers,
        );
        return;
      }

      writeJson(response, 404, {
        error: "not_found",
        scenarios: ADSP_CONTROLLED_REMOTE_SCENARIOS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = error instanceof RangeError ? 413 : 500;
      if (!response.headersSent) {
        writeJson(response, statusCode, { error: "request_rejected", message });
      } else {
        response.destroy();
      }
    }
  });

  return {
    server,
    async start() {
      if (started) {
        if (!info) throw new Error("controlled ActivityPub target start state is inconsistent");
        return info;
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      info = listeningInfo(server, host);
      started = true;
      return info;
    },
    async close() {
      if (!started) return;
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      started = false;
      info = null;
    },
    reset() {
      state.reset();
    },
    snapshot() {
      return state.snapshot();
    },
  };
}
