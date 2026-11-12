import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import { CanonicalNotificationConsumer } from "../CanonicalNotificationConsumer.js";
import type { CanonicalNotificationConsumerConfig } from "../CanonicalNotificationConsumer.js";
import type { CanonicalNotificationPayload } from "../CanonicalNotificationConsumer.js";

const durableResponse = {
  ok: true, durable: true, duplicate: false, delivered: false,
  queuedRecipients: 1,
};
const validPayload: CanonicalNotificationPayload = {
  canonicalIntentId: "http-proof-1",
  kind: "FollowAdd", sourceProtocol: "activitypub",
  actor: { webId: "https://remote.example.test/author" },
  createdAt: "2026-11-12T00:00:00.000Z",
};
describe("live loopback HTTP canonical PG receipt boundary", () => {
  let server: Server;
  let origin = "";
  let status = 202;
  let body: unknown = durableResponse;
  let proof: {callActivityPods: (value: CanonicalNotificationPayload) => Promise<void>};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const buffers: Buffer[] = [];
      let size = 0;
      req.on("data", chunk => {
        size += (chunk as Buffer).byteLength;
        if (size > 262144) { req.destroy(); return; }
        buffers.push(Buffer.from(chunk as Buffer));
      });
      req.on("end", () => {
        let intentId: unknown;
        try {
          intentId = (JSON.parse(Buffer.concat(buffers).toString("utf8")) as {
            canonicalIntentId?: unknown
          }).canonicalIntentId;
        } catch { intentId = null; }
        // Match the real PostgreSQL API's exact request intent even when
        // multiple concurrent HTTP requests are in flight.
        const reply = body && typeof body === "object" && !Array.isArray(body) &&
          (body as Record<string, unknown>)["durable"] === true &&
          (body as Record<string, unknown>)["canonicalIntentId"] === undefined
          ? {...body as Record<string, unknown>, canonicalIntentId: intentId} : body;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>(resolve => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing HTTP test listener");
    origin = `http://127.0.0.1:${address.port}`;
    const config: CanonicalNotificationConsumerConfig = {
      brokers: ["127.0.0.1:9092"],
      clientId: "live-http-proof", consumerGroupId: "live-http-proof",
      canonicalTopic: "canonical.v1",
      activityPodsBaseUrl: origin, activityPodsBearerToken: "test-only",
      requireDurablePgAck: true,
    };
    proof = new CanonicalNotificationConsumer(config) as unknown as typeof proof;
  });
  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it("accepts only a completed PG transaction, not a legacy HTTP 202", async () => {
    status = 202; body = durableResponse;
    await expect(proof.callActivityPods(validPayload)).resolves.toBeUndefined();
    body = { ok: true, delivered: true, recipients: ["https://paper.example/alice"] };
    await expect(proof.callActivityPods(validPayload)).rejects.toThrow(/does not prove committed PostgreSQL/);
    body = durableResponse;
  });

  it("rejects 503, accepts completed PG 409, and rejects false duplicate 409", async () => {
    status = 503; body = { error: "db unavailable" };
    await expect(proof.callActivityPods(validPayload)).rejects.toThrow(/not accepted/);
    status = 409; body = { ...durableResponse, duplicate: true };
    await expect(proof.callActivityPods(validPayload)).resolves.toBeUndefined();
    body = { ok: true, duplicate: true };
    await expect(proof.callActivityPods(validPayload)).rejects.toThrow(/does not prove committed PostgreSQL/);
    status = 202; body = { ...durableResponse, canonicalIntentId: "another-request" };
    await expect(proof.callActivityPods(validPayload)).rejects.toThrow(/does not prove committed PostgreSQL/);
    status = 202; body = durableResponse;
  });

  it("measures bounded local HTTP tail latency and memory growth over 512 receipts", async () => {
    status = 202; body = durableResponse;
    const concurrency = 8, count = 512;
    let next = 0;
    const times: number[] = [];
    const rssBefore = process.memoryUsage().rss;
    const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const seq = next++;
        const t = performance.now();
        await proof.callActivityPods({ ...validPayload, canonicalIntentId: `http-proof-${seq}` });
        times.push(performance.now() - t);
      }
    }));
    const totalMs = performance.now() - start;
    times.sort((a, b) => a - b);
    const percentile = (p: number) => Number(
      times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)]!.toFixed(3),
    );
    expect(times).toHaveLength(count);
    console.log(JSON.stringify({
      scope: "local-loopback-undici-canonical-pg-ack",
      count, concurrency,
      throughputRequestsPerSecond: Number((1000 * count / totalMs).toFixed(2)),
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      rssGrowthBytes: process.memoryUsage().rss - rssBefore,
      note: "Single-process local HTTP only, not Kafka/PG/network/production capacity",
    }));
  });
});
