import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { WebSocketServer } from "ws";
import { DefaultAtFirehoseConsumer } from "../ingress/AtFirehoseConsumer.js";
import { RedisAtFirehoseSourceFence } from "../ingress/RedisAtFirehoseSourceFence.js";
import { InMemoryAtFirehoseCursorManager } from "../ingress/AtFirehoseCursorManager.js";
import type { AtFirehoseDecoder } from "../ingress/AtFirehoseDecoder.js";
import type { EventPublisher } from "../../core-domain/events/CoreIdentityEvents.js";

const decoder: AtFirehoseDecoder = {
  decodeHeader(frame) {
    const seq = Number(Buffer.from(frame).toString());
    if (!Number.isSafeInteger(seq) || seq < 1) throw Error("invalid test frame");
    return { seq, eventType: "#commit", did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" };
  },
  decodeFull: () => ({}),
};
let redis: Redis;
let server: WebSocketServer;
let port: number;
const connections: number[] = [];
const running: DefaultAtFirehoseConsumer[] = [];
const path = "/xrpc/com.atproto.sync.subscribeRepos";
const until = async (predicate: () => boolean, timeoutMs = 7000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) throw Error("source owner did not take over");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
beforeAll(async () => {
  redis = new Redis(process.env["REDIS_URL"] || "redis://127.0.0.1:6379", {
    retryStrategy: () => null, maxRetriesPerRequest: 1, connectTimeout: 2000,
  });
  await redis.ping();
  server = new WebSocketServer({ host: "127.0.0.1", port: 0, path });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing listener");
  port = address.port;
  server.on("connection", socket => {
    const number = connections.push(connections.length + 1);
    socket.send(Buffer.from(String(10 + number)));
  });
});
afterAll(async () => {
  for (const consumer of running) {
    // Source IDs used below are unique per test; stop is safe on nonowners.
    for (const source of activeSources) await consumer.stop(source);
  }
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await redis.quit().catch(() => redis.disconnect());
});
const activeSources: string[] = [];

describe("multi-worker verified Sync source ownership", () => {
  it("keeps one live upstream socket and promotes a standby after owner release", async () => {
    const sourceId = "redis-source-" + randomUUID();
    activeSources.push(sourceId);
    const startConnections = connections.length;
    const url = "ws://127.0.0.1:" + port + path;
    const source = {id: sourceId, url, sourceType: "relay" as const};
    const eventsA: number[] = [], eventsB: number[] = [];
    const publisher = (events: number[]) => ({
      publish: vi.fn(async (_topic: string, event: {seq:number}) => {
        events.push(event.seq);
      }), publishBatch: vi.fn(async () => undefined),
    }) as unknown as EventPublisher;
    const a = new DefaultAtFirehoseConsumer(decoder,
      new InMemoryAtFirehoseCursorManager(), publisher(eventsA),
      "at.firehose.raw.v1", new RedisAtFirehoseSourceFence(redis, 1200));
    const b = new DefaultAtFirehoseConsumer(decoder,
      new InMemoryAtFirehoseCursorManager(), publisher(eventsB),
      "at.firehose.raw.v1", new RedisAtFirehoseSourceFence(redis, 1200));
    running.push(a, b);
    await a.start(source);
    await until(() => eventsA.length === 1);
    await b.start(source); // standby must not open a second socket
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(connections.length - startConnections).toBe(1);
    expect(eventsB).toEqual([]);
    await a.stop(sourceId);
    await until(() => eventsB.length === 1);
    expect(eventsB).toEqual([12]);
    expect(connections.length - startConnections).toBe(2);
    await b.stop(sourceId);
    const final = new RedisAtFirehoseSourceFence(redis, 1200);
    const lease = (await final.tryAcquire(sourceId))!;
    expect(lease).not.toBeNull();
    expect(await final.getResumeCursor(sourceId, lease)).toBe(12);
    await final.release(sourceId, lease);
  }, 10000);
});
