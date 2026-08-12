import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entries: [] as Array<{ messageId: string; job: Record<string, unknown> }>,
  evalMock: vi.fn(),
  migrationMock: vi.fn(),
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

vi.mock("../../delivery/outbound-delivery-claims.js", () => ({
  migrateLegacyCompletedDeliveryMarkers: state.migrationMock,
}));

vi.mock("redis", () => ({
  createClient: vi.fn(() => state.client),
}));

vi.mock("../sidecar-redis-queue-core.js", () => {
  class CoreRedisStreamsQueue {
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}

    async *consumeOutbound(): AsyncIterable<{ messageId: string; job: Record<string, unknown> }> {
      for (const entry of state.entries) yield entry;
    }
  }

  return { RedisStreamsQueue: CoreRedisStreamsQueue };
});

import {
  DELAYED_OUTBOUND_MIN_DELAY_MS,
  DELAYED_OUTBOUND_PROMOTION_BATCH_SIZE,
  RedisStreamsQueue,
} from "../sidecar-redis-queue.js";

function outboundJob(notBeforeMs: number) {
  return {
    jobId: "activity::https://remote.example/inbox",
    activityId: "https://local.example/activities/1",
    actorUri: "https://local.example/alice",
    activity: JSON.stringify({ type: "Create" }),
    targetInbox: "https://remote.example/inbox",
    targetDomain: "remote.example",
    attempt: 3,
    maxAttempts: 8,
    notBeforeMs,
    deferCount: 2,
    lastError: "HTTP 503",
    meta: { visibility: "public" },
  };
}

describe("durable delayed outbound queue", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    state.entries.length = 0;
    state.evalMock.mockReset();
    state.migrationMock.mockReset().mockResolvedValue(0);
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
    vi.unstubAllEnvs();
  });

  it("atomically parks long-delay work outside the trimmed ready Stream before yielding", async () => {
    const queue = new RedisStreamsQueue({
      redisUrl: "redis://test",
      outboundStreamKey: "ap:queue:outbound:test",
      consumerGroup: "test-workers",
      maxStreamLength: 123,
    } as any);

    // connect() performs an initial due-promotion pass; isolate the subsequent park call.
    state.evalMock.mockResolvedValue(0);
    await queue.connect();
    state.evalMock.mockClear();

    const job = outboundJob(Date.now() + DELAYED_OUTBOUND_MIN_DELAY_MS + 60_000);
    state.entries.push({ messageId: "1700000000000-1", job });

    const result = await queue.consumeOutbound()[Symbol.asyncIterator]().next();

    expect(result.done).toBe(true);
    expect(state.evalMock).toHaveBeenCalledTimes(1);
    const [, options] = state.evalMock.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(options.keys).toEqual([
      "ap:queue:outbound:test:delayed:v1",
      "ap:queue:outbound:test:delayed-payload:v1",
      "ap:queue:outbound:test",
    ]);
    expect(options.arguments[0]).toBe(job.jobId);
    expect(options.arguments[1]).toBe(String(job.notBeforeMs));
    expect(JSON.parse(options.arguments[2] ?? "{}")).toMatchObject(job);
    expect(options.arguments[4]).toBe("test-workers");
    expect(options.arguments[5]).toBe("1700000000000-1");

    await queue.disconnect();
  });

  it("promotes due delayed jobs back into the ready Stream in a bounded atomic batch", async () => {
    const queue = new RedisStreamsQueue({
      redisUrl: "redis://test",
      outboundStreamKey: "ap:queue:outbound:test",
      maxStreamLength: 321,
    } as any);

    state.evalMock.mockResolvedValue(0);
    await queue.connect();
    state.evalMock.mockClear();
    state.evalMock.mockResolvedValue(2);

    const nowMs = 1_700_000_123_456;
    await expect(queue.promoteDueOutbound(nowMs)).resolves.toBe(2);

    expect(state.evalMock).toHaveBeenCalledTimes(1);
    const [, options] = state.evalMock.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(options.keys).toEqual([
      "ap:queue:outbound:test:delayed:v1",
      "ap:queue:outbound:test:delayed-payload:v1",
      "ap:queue:outbound:test",
    ]);
    expect(options.arguments).toEqual([
      String(nowMs),
      String(DELAYED_OUTBOUND_PROMOTION_BATCH_SIZE),
      "321",
    ]);

    await queue.disconnect();
  });
});
