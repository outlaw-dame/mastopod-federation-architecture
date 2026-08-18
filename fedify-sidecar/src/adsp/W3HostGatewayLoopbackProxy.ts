import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface W3HostGatewayLoopbackProxyOptions {
  bindHost?: string;
  bindPort?: number;
  upstreamHost?: string;
  upstreamPort?: number;
  maxBodyBytes?: number;
}

export interface W3HostGatewayLoopbackProxy {
  readonly server: Server;
  start(): Promise<{ bindHost: string; bindPort: number; upstreamHost: string; upstreamPort: number }>;
  close(): Promise<void>;
}

const DEFAULT_BIND_HOST = "0.0.0.0";
const DEFAULT_BIND_PORT = 18081;
const DEFAULT_UPSTREAM_HOST = "127.0.0.1";
const DEFAULT_UPSTREAM_PORT = 18080;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function assertPort(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${name} must be a safe integer from 1 through 65535`);
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

async function pipeBoundedBody(
  source: IncomingMessage,
  destination: ReturnType<typeof httpRequest>,
  maxBodyBytes: number,
  response: ServerResponse,
): Promise<void> {
  let total = 0;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBodyBytes) {
      destination.destroy();
      if (!response.headersSent) {
        response.writeHead(413, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      }
      response.end("ADSP P2 W3 host gateway request body too large\n");
      return;
    }
    if (!destination.write(bytes)) {
      await new Promise<void>(resolve => destination.once("drain", resolve));
    }
  }
  destination.end();
}

export function createW3HostGatewayLoopbackProxy(
  options: W3HostGatewayLoopbackProxyOptions = {},
): W3HostGatewayLoopbackProxy {
  const bindHost = options.bindHost ?? DEFAULT_BIND_HOST;
  const bindPort = options.bindPort ?? DEFAULT_BIND_PORT;
  const upstreamHost = options.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
  const upstreamPort = options.upstreamPort ?? DEFAULT_UPSTREAM_PORT;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  if (bindHost !== DEFAULT_BIND_HOST) {
    throw new TypeError("W3 host gateway proxy must bind exactly 0.0.0.0");
  }
  if (upstreamHost !== DEFAULT_UPSTREAM_HOST) {
    throw new TypeError("W3 host gateway proxy must forward only to literal IPv4 loopback");
  }
  assertPort("bindPort", bindPort);
  assertPort("upstreamPort", upstreamPort);
  if (bindPort === upstreamPort) {
    throw new TypeError("W3 host gateway proxy bind and upstream ports must differ");
  }
  assertPositiveSafeInteger("maxBodyBytes", maxBodyBytes);

  const server = createServer((incoming, outgoing) => {
    const upstream = httpRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, connection: "close" },
      },
      upstreamResponse => {
        outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(outgoing);
      },
    );

    upstream.once("error", error => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      }
      if (!outgoing.writableEnded) {
        outgoing.end(`ADSP P2 W3 host gateway upstream error: ${error.message}\n`);
      }
    });

    void pipeBoundedBody(incoming, upstream, maxBodyBytes, outgoing).catch(error => {
      upstream.destroy();
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      }
      if (!outgoing.writableEnded) outgoing.end(`ADSP P2 W3 host gateway error: ${String(error)}\n`);
    });
  });

  let started = false;
  return {
    server,
    async start() {
      if (started) throw new Error("W3 host gateway proxy is already started");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(bindPort, bindHost, resolve);
      });
      started = true;
      return { bindHost, bindPort, upstreamHost, upstreamPort };
    },
    async close() {
      if (!started) return;
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      started = false;
    },
  };
}
