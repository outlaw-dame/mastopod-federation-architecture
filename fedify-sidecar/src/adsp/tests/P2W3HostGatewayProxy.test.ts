import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createP2W3HostGatewayProxy } from "../P2W3HostGatewayProxy.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => server.close()));
});

interface UpstreamObservation {
  url: string;
  body: string;
  host: string | undefined;
  connection: string | undefined;
  transferEncoding: string | undefined;
  contentLength: string | undefined;
  hop: string | undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

async function listenUpstream(): Promise<{
  port: number;
  close(): Promise<void>;
  observed: UpstreamObservation[];
  startedRequests(): number;
}> {
  const observed: UpstreamObservation[] = [];
  let started = 0;
  const server = createServer((req, res) => {
    started += 1;
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      observed.push({
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        host: singleHeader(req.headers.host),
        connection: singleHeader(req.headers.connection),
        transferEncoding: singleHeader(req.headers["transfer-encoding"]),
        contentLength: singleHeader(req.headers["content-length"]),
        hop: singleHeader(req.headers["x-hop"]),
      });
      res.writeHead(202, {
        "content-type": "application/json",
        connection: "x-response-hop",
        "x-response-hop": "remove-me",
      });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    observed,
    startedRequests: () => started,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

function httpCall(
  port: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/proof",
      method: "POST",
      headers: {
        host: "authority.example",
        "content-length": Buffer.byteLength(body),
        ...extraHeaders,
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: res.headers,
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("ADSP P2 W3 host-gateway proxy", () => {
  it("forwards only after validation, preserves authority, and isolates hop-by-hop headers in both directions", async () => {
    const upstream = await listenUpstream();
    servers.push(upstream);
    const proxy = createP2W3HostGatewayProxy({ bindHost: "127.0.0.1", bindPort: 19081, upstreamPort: upstream.port, maxBodyBytes: 1024 });
    servers.push(proxy);
    await proxy.start();

    const result = await httpCall(19081, "payload", { connection: "x-hop", "x-hop": "remove-me" });
    expect(result.status).toBe(202);
    expect(result.body).toBe('{"ok":true}');
    expect(result.headers["x-response-hop"]).toBeUndefined();
    expect(upstream.observed).toHaveLength(1);
    expect(upstream.observed[0]).toMatchObject({
      url: "/proof",
      body: "payload",
      host: "authority.example",
      transferEncoding: undefined,
      contentLength: "7",
      hop: undefined,
    });
    expect(upstream.observed[0]?.connection).not.toContain("x-hop");
  });

  it("fails closed on oversized bodies before opening an upstream request", async () => {
    const upstream = await listenUpstream();
    servers.push(upstream);
    const proxy = createP2W3HostGatewayProxy({ bindHost: "127.0.0.1", bindPort: 19082, upstreamPort: upstream.port, maxBodyBytes: 4 });
    servers.push(proxy);
    await proxy.start();

    const result = await httpCall(19082, "12345");
    expect(result.status).toBe(413);
    expect(upstream.startedRequests()).toBe(0);
    expect(upstream.observed).toEqual([]);
  });

  it("cannot be constructed outside explicit test/development runtime", () => {
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => createP2W3HostGatewayProxy({ bindPort: 19083, upstreamPort: 8080 })).toThrow(/restricted to test\/development/u);
    } finally {
      if (previous === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = previous;
    }
  });
});
