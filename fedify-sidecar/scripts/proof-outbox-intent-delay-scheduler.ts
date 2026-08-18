import { createClient } from "redis";
import {
  RedisOutboxIntentDelayScheduler,
} from "../src/delivery/outbox-intent-delay-scheduler.js";
import type { OutboxIntent } from "../src/queue/sidecar-redis-queue.js";

const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const suffix = `${process.pid}-${Date.now()}`;
const readyStreamKey = `ap:test:outbox-intent:${suffix}`;
const dlqStreamKey = `ap:test:dlq:outbox-intent:${suffix}`;
const delayedKey = `${readyStreamKey}:delayed:v1`;
const payloadKey = `${readyStreamKey}:delayed-payload:v1`;
const group = `test-workers-${suffix}`;
const consumer = `worker-${suffix}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const client = createClient({ url: redisUrl });
client.on("error", error => console.error("proof Redis error", error));

const scheduler = new RedisOutboxIntentDelayScheduler({
  redisUrl,
  readyStreamKey,
  dlqStreamKey,
  consumerGroup: group,
  maxStreamLength: 100,
  maxDlqLength: 100,
  promotionIntervalMs: 60_000,
  promotionBatchSize: 10,
});

try {
  await client.connect();
  await client.sendCommand(["XGROUP", "CREATE", readyStreamKey, group, "0", "MKSTREAM"]);

  const sourceId = await client.sendCommand([
    "XADD", readyStreamKey, "*",
    "intentId", "proof-intent",
    "activityId", "https://local.example/activities/proof",
    "actorUri", "https://local.example/users/alice",
    "activity", JSON.stringify({ id: "https://local.example/activities/proof", type: "Create" }),
    "targets", "[]",
    "createdAt", String(Date.now() - 1000),
    "attempt", "0",
    "maxAttempts", "8",
    "notBeforeMs", "0",
    "lastError", "",
    "meta", "",
    "bridgeHints", "",
  ]);
  assert(typeof sourceId === "string", "Expected source Stream message id");

  const claimed = await client.sendCommand([
    "XREADGROUP", "GROUP", group, consumer, "COUNT", "1", "STREAMS", readyStreamKey, ">",
  ]);
  assert(claimed !== null, "Expected source message to enter the consumer-group PEL");

  await scheduler.start();

  const dueAt = Date.now() + 60_000;
  const intent: OutboxIntent = {
    intentId: "proof-intent",
    activityId: "https://local.example/activities/proof",
    actorUri: "https://local.example/users/alice",
    activity: JSON.stringify({ id: "https://local.example/activities/proof", type: "Create" }),
    targets: [],
    createdAt: Date.now() - 1000,
    attempt: 1,
    maxAttempts: 8,
    notBeforeMs: dueAt,
    lastError: "proof transient",
    meta: { visibility: "public" },
  };

  await scheduler.persistReplacementAndAck(sourceId, intent);

  const delayedScore = await client.sendCommand(["ZSCORE", delayedKey, intent.intentId]);
  const delayedPayload = await client.sendCommand(["HGET", payloadKey, intent.intentId]);
  const readyLenAfterPark = Number(await client.sendCommand(["XLEN", readyStreamKey]));
  const pendingAfterPark = await client.sendCommand(["XPENDING", readyStreamKey, group]);

  assert(delayedScore !== null, "Delayed schedule entry was not persisted");
  assert(typeof delayedPayload === "string" && JSON.parse(delayedPayload).attempt === 1, "Delayed payload was not persisted");
  assert(readyLenAfterPark === 1, `Parking created an unexpected ready replacement: XLEN=${readyLenAfterPark}`);
  assert(Array.isArray(pendingAfterPark) && Number(pendingAfterPark[0]) === 0, "Source message was not acknowledged atomically");

  const early = await scheduler.promoteDue(dueAt - 1);
  assert(early === 0, `Future work promoted early: ${early}`);
  assert(Number(await client.sendCommand(["XLEN", readyStreamKey])) === 1, "Future work appeared in ready Stream early");

  const promoted = await scheduler.promoteDue(dueAt + 1);
  assert(promoted === 1, `Expected one due intent promotion, got ${promoted}`);
  assert(Number(await client.sendCommand(["XLEN", readyStreamKey])) === 2, "Due intent was not XADDed to ready Stream");
  assert(await client.sendCommand(["ZSCORE", delayedKey, intent.intentId]) === null, "Promoted schedule entry was not removed");
  assert(await client.sendCommand(["HGET", payloadKey, intent.intentId]) === null, "Promoted payload was not removed");

  const corruptId = "corrupt-intent";
  await client.sendCommand(["HSET", payloadKey, corruptId, "{not-json"]);
  await client.sendCommand(["ZADD", delayedKey, String(Date.now() - 1), corruptId]);
  const readyBeforeCorrupt = Number(await client.sendCommand(["XLEN", readyStreamKey]));
  const quarantinedPromotionCount = await scheduler.promoteDue(Date.now());
  const readyAfterCorrupt = Number(await client.sendCommand(["XLEN", readyStreamKey]));
  const dlqLen = Number(await client.sendCommand(["XLEN", dlqStreamKey]));

  assert(quarantinedPromotionCount === 0, "Corrupt delayed payload was counted as a successful promotion");
  assert(readyAfterCorrupt === readyBeforeCorrupt, "Corrupt delayed payload leaked into ready Stream");
  assert(dlqLen === 1, `Corrupt delayed payload was not quarantined to DLQ: XLEN=${dlqLen}`);
  assert(await client.sendCommand(["ZSCORE", delayedKey, corruptId]) === null, "Corrupt schedule entry was not removed after DLQ quarantine");

  console.log(JSON.stringify({
    ok: true,
    sourceId,
    readyLenAfterPark,
    promoted,
    corruptDlqEntries: dlqLen,
  }));
} finally {
  await scheduler.stop().catch(() => undefined);
  if (client.isOpen) {
    await client.del([readyStreamKey, dlqStreamKey, delayedKey, payloadKey]).catch(() => undefined);
    await client.quit().catch(() => undefined);
  }
}
