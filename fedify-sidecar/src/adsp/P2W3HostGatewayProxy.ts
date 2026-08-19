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
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

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

function withoutHopByHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionTokens = String(headers["connection"] ?? "")
    .split(",")
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
  for (const header of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) delete result[header];
  return result;
}

function forwardedRequestHeaders(headers: IncomingHttpHeaders, bodyLength: number): IncomingHttpHeaders {
  const result = withoutHopByHopHeaders(headers);
  delete result["content-length"];
  result["content-length"] = String(bodyLength);
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
    const chunks: Buffer[] = [];

    const rejectOversized = (): void => {
      if (rejected) return;
      rejected = true;
      if (!outgoing.headersSent) {
        outgoing.writeHead(413, {
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
        });
      }
      if (!outgoing.writableEnded) outgoing.end("ADSP P2 W3 gateway proxy request body too large\n");
    };

    const declaredLength = incoming.headers["content-length"];
    if (declaredLength !== undefined) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
        outgoing.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
        outgoing.end("ADSP P2 W3 gateway proxy invalid Content-Length\n");
        incoming.resume();
        return;
      }
      const parsedLength = Number(declaredLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBodyBytes) {
        rejectOversized();
        incoming.resume();
        return;
      }
    }

    incoming.on("data", chunk => {
      if (rejected) return;
      const bytes = Buffer.from(chunk);
      received += bytes.byteLength;
      if (received > maxBodyBytes) {
        rejectOversized();
        return;
      }
      chunks.push(bytes);
    });

    incoming.on("end", () => {
      if (rejected) return;
      const body = Buffer.concat(chunks, received);
      const upstream = httpRequest(
        {
          hostname: upstreamHost,
          port: options.upstreamPort,
          method: incoming.method,
          path: incoming.url,
          headers: forwardedRequestHeaders(incoming.headers, body.byteLength),
        },
        upstreamResponse => {
          outgoing.writeHead(upstreamResponse.statusCode ?? 502, withoutHopByHopHeaders(upstreamResponse.headers));
          upstreamResponse.pipe(outgoing);
        },
      );

      upstream.on("error", error => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502, {
            "content-type": "text/plain; charset=utf-8",
            connection: "close",
          });
        }
        if (!outgoing.writableEnded) outgoing.end(`ADSP P2 W3 gateway proxy upstream error: ${error.message}\n`);
      });
      upstream.end(body);
    });
    incoming.on("error", () => {
      rejected = true;
      if (!outgoing.writableEnded) outgoing.destroy();
    });
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
