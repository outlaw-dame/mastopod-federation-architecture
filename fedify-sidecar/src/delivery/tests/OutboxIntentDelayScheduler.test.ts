import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  evalMock: vi.fn(),
  client: {
    isOpen: false,
    on: vi.fn(),
    connect: vi.fn(),
    quit: vi.fn(),
    eval: vi.fn(),
  },
}));

vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("redis", () => ({
  createClient: vi.fn(() => state.client),
}));

import { RedisOutboxIntentDelayScheduler } from "../outbox-intent-delay-scheduler.js";
import type { OutboxIntent } from "../../queue/sidecar-redis-queue.js";

function makeIntent(overrides: Partial<OutboxIntent> = {}): OutboxIntent {
  return {
    intentId: "intent-1",
    activityId: "https://local.example/activities/1",
    actorUri: "https://local.example/users/alice",
    activity: JSON.stringify({ id: "https://local.example/activities/1", type: "Create" }),
    targets: [],
    createdAt: Date.now() - 1_000,
    attempt: 2,
    maxAttempts: 8,
    notBeforeMs: Date.now() + 60_000,
    meta: { visibility: "public" },
    ...overrides,
  };
}

function makeScheduler() {
  return new RedisOutboxIntentDelayScheduler({
    redisUrl: "redis://test",
    readyStreamKey: "ap:queue:outbox-intent:test",
    dlqStreamKey: "ap:queue:dlq:outbox-intent:test",
    consumerGroup: "test-workers",
    maxStreamLength: 321,
    maxDlqLength: 654,
    promotionIntervalMs: 60_000,
  });
}

describe("RedisOutboxIntentDelayScheduler", () => {
  beforeEach(() => {
    state.evalMock.mockReset().mockResolvedValue(1);
    state.client.isOpen = false;
    state.client.on.mockReset();
    state.client.connect.mockReset().mockImplementation(async () => {
      state.client.isOpen = true;
    });
    state.client.quit.mockReset().mockImplementation(async () => {
      state.client.isOpen = false;
    });
    state.client.eval.mockReset().mockImplementation((...args: unknown[]) => state.evalMock(...args));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists delayed replacement and acknowledges the source in one Redis script", async () => {
    const scheduler = makeScheduler();
    await scheduler.start();
    state.evalMock.mockClear();

    const intent = makeIntent();
    await scheduler.persistReplacementAndAck("1700000000000-1", intent);

    expect(state.evalMock).toHaveBeenCalledTimes(1);
    const [script, options] = state.evalMock.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(options.keys).toEqual([
      "ap:queue:outbox-intent:test:delayed:v1",
      "ap:queue:outbox-intent:test:delayed-payload:v1",
      "ap:queue:outbox-intent:test",
    ]);
    expect(options.arguments[0]).toBe(intent.intentId);
    expect(options.arguments[4]).toBe("test-workers");
    expect(options.arguments[5]).toBe("1700000000000-1");
    expect(script.indexOf("redis.call('HSET'")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("redis.call('ZADD'")).toBeGreaterThan(script.indexOf("redis.call('HSET'"));
    expect(script.indexOf("redis.call('XACK'")).toBeGreaterThan(script.indexOf("redis.call('ZADD'"));
    expect(script).toContain("oldAttempt > newAttempt");
    expect(script).toContain("oldNotBefore >= newNotBefore");

    await scheduler.stop();
  });

  it("promotes due work atomically and quarantines corrupt/orphaned records instead of blocking the batch", async () => {
    const scheduler = makeScheduler();
    await scheduler.start();
    state.evalMock.mockClear();
    state.evalMock.mockResolvedValue(3);

    const nowMs = 1_700_000_123_456;
    await expect(scheduler.promoteDue(nowMs)).resolves.toBe(3);

    const [script, options] = state.evalMock.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(options.keys).toEqual([
      "ap:queue:outbox-intent:test:delayed:v1",
      "ap:queue:outbox-intent:test:delayed-payload:v1",
      "ap:queue:outbox-intent:test",
      "ap:queue:dlq:outbox-intent:test",
    ]);
    expect(options.arguments).toEqual([String(nowMs), "100", "321", "654"]);
    expect(script).toContain("Corrupt delayed outbox-intent payload");
    expect(script).toContain("Orphaned delayed outbox-intent schedule entry");
    expect(script).toContain("'type', 'outbox_intent'");
    expect(script.indexOf("'XADD', KEYS[3]")).toBeLessThan(script.indexOf("redis.call('ZREM'"));
    expect(script.indexOf("'XADD', KEYS[4]")).toBeLessThan(script.indexOf("redis.call('ZREM'"));

    await scheduler.stop();
  });

  it("fails closed when asked to park work whose deadline is already due", async () => {
    const scheduler = makeScheduler();
    await scheduler.start();
    state.evalMock.mockClear();

    await expect(
      scheduler.persistReplacementAndAck("1700000000000-2", makeIntent({ notBeforeMs: Date.now() - 1 })),
    ).rejects.toThrow(/future notBeforeMs/u);
    expect(state.evalMock).not.toHaveBeenCalled();

    await scheduler.stop();
  });
});
