import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createW3HostGatewayLoopbackProxy } from "../W3HostGatewayLoopbackProxy.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

describe("W3HostGatewayLoopbackProxy", () => {
  it("forwards through the gateway to literal loopback while preserving Host and body", async () => {
    const observed: Array<{ method?: string; url?: string; host?: string; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observed.push({
          method: request.method,
          url: request.url,
          host: request.headers.host,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(202, { "content-type": "application/activity+json" });
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    closers.push(() => new Promise<void>((resolve, reject) => upstream.close(error => (error ? reject(error) : resolve()))));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not expose a TCP port");

    const proxy = createW3HostGatewayLoopbackProxy({ bindPort: 18091, upstreamPort: address.port });
    await proxy.start();
    closers.push(() => proxy.close());

    const response = await fetch("http://127.0.0.1:18091/actor/success", {
      method: "POST",
      headers: { host: "127.0.0.1:18080", "content-type": "application/activity+json" },
      body: '{"type":"Create"}',
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"ok":true}');
    expect(observed).toEqual([
      {
        method: "POST",
        url: "/actor/success",
        host: "127.0.0.1:18080",
        body: '{"type":"Create"}',
      },
    ]);
  });

  it("fails closed if asked to bind somewhere else or forward outside loopback", () => {
    expect(() => createW3HostGatewayLoopbackProxy({ bindHost: "127.0.0.1" })).toThrow(/bind exactly 0\.0\.0\.0/u);
    expect(() => createW3HostGatewayLoopbackProxy({ upstreamHost: "host.docker.internal" })).toThrow(/literal IPv4 loopback/u);
    expect(() => createW3HostGatewayLoopbackProxy({ bindPort: 18080, upstreamPort: 18080 })).toThrow(/must differ/u);
  });

  it("bounds request bodies", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    closers.push(() => new Promise<void>((resolve, reject) => upstream.close(error => (error ? reject(error) : resolve()))));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not expose a TCP port");

    const proxy = createW3HostGatewayLoopbackProxy({ bindPort: 18092, upstreamPort: address.port, maxBodyBytes: 4 });
    await proxy.start();
    closers.push(() => proxy.close());
    const response = await fetch("http://127.0.0.1:18092/inbox/success", { method: "POST", body: "12345" });
    expect(response.status).toBe(413);
  });
});
