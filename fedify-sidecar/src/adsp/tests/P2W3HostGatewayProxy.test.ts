import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createP2W3HostGatewayProxy } from "../P2W3HostGatewayProxy.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => server.close()));
});

async function listenUpstream(): Promise<{ port: number; close(): Promise<void>; observed: Array<{ url: string; body: string; host?: string }> }> {
  const observed: Array<{ url: string; body: string; host?: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      observed.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), host: req.headers.host });
      res.writeHead(202, { "content-type": "application/json" });
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
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

function httpCall(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/proof", method: "POST", headers: { host: "authority.example", "content-length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("ADSP P2 W3 host-gateway proxy", () => {
  it("forwards through a gateway listener while preserving request authority", async () => {
    const upstream = await listenUpstream();
    servers.push(upstream);
    const proxy = createP2W3HostGatewayProxy({ bindHost: "127.0.0.1", bindPort: 19081, upstreamPort: upstream.port, maxBodyBytes: 1024 });
    servers.push(proxy);
    await proxy.start();

    const result = await httpCall(19081, "payload");
    expect(result).toEqual({ status: 202, body: '{"ok":true}' });
    expect(upstream.observed).toEqual([{ url: "/proof", body: "payload", host: "authority.example" }]);
  });

  it("fails closed on oversized bodies", async () => {
    const upstream = await listenUpstream();
    servers.push(upstream);
    const proxy = createP2W3HostGatewayProxy({ bindHost: "127.0.0.1", bindPort: 19082, upstreamPort: upstream.port, maxBodyBytes: 4 });
    servers.push(proxy);
    await proxy.start();

    const result = await httpCall(19082, "12345");
    expect(result.status).toBe(413);
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
