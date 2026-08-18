import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";

export interface P2W3HostGatewayProxyOptions {
  bindHost?: string;
  bindPort: number;
  upstreamHost?: string;
  upstreamPort: number;
  maxBodyBytes?: number;
}

export interface P2W3HostGatewayProxy {
  readonly server: Server;
  start(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_BIND_HOST = "0.0.0.0";
const DEFAULT_UPSTREAM_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

function assertPort(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 through 65535`);
  }
}

function assertHost(name: string, value: string): void {
  if (!value || value !== value.trim() || /[\s/\0]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty hostname or address without whitespace or path characters`);
  }
}

function assertMaxBodyBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maxBodyBytes must be a positive safe integer");
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  delete result["connection"];
  delete result["proxy-connection"];
  delete result["transfer-encoding"];
  return result;
}

export function createP2W3HostGatewayProxy(options: P2W3HostGatewayProxyOptions): P2W3HostGatewayProxy {
  const bindHost = options.bindHost ?? DEFAULT_BIND_HOST;
  const upstreamHost = options.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  assertHost("bindHost", bindHost);
  assertHost("upstreamHost", upstreamHost);
  assertPort("bindPort", options.bindPort);
  assertPort("upstreamPort", options.upstreamPort);
  assertMaxBodyBytes(maxBodyBytes);

  if (process.env["NODE_ENV"] !== "test" && process.env["NODE_ENV"] !== "development") {
    throw new Error("ADSP P2 W3 host-gateway proxy is restricted to test/development runtimes");
  }

  const server = createServer((incoming, outgoing) => {
    let received = 0;
    let rejected = false;
    const upstream = httpRequest(
      {
        hostname: upstreamHost,
        port: options.upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: forwardedHeaders(incoming.headers),
      },
      upstreamResponse => {
        if (rejected) {
          upstreamResponse.resume();
          return;
        }
        outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(outgoing);
      },
    );

    upstream.on("error", error => {
      if (rejected) return;
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
        });
      }
      if (!outgoing.writableEnded) outgoing.end(`ADSP P2 W3 gateway proxy upstream error: ${error.message}\n`);
    });

    incoming.on("data", chunk => {
      if (rejected) return;
      const bytes = Buffer.from(chunk);
      received += bytes.byteLength;
      if (received > maxBodyBytes) {
        rejected = true;
        upstream.destroy();
        if (!outgoing.headersSent) {
          outgoing.writeHead(413, {
            "content-type": "text/plain; charset=utf-8",
            connection: "close",
          });
        }
        if (!outgoing.writableEnded) outgoing.end("ADSP P2 W3 gateway proxy request body too large\n");
        return;
      }
      upstream.write(bytes);
    });
    incoming.on("end", () => {
      if (!rejected) upstream.end();
    });
    incoming.on("error", () => upstream.destroy());
  });

  return {
    server,
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.bindPort, bindHost, resolve);
      });
    },
    async close(): Promise<void> {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    },
  };
}
