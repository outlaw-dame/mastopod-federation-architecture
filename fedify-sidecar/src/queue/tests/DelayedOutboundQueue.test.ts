import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entries: [] as Array<{ messageId: string; job: Record<string, any> }>,
  evalMock: vi.fn(),
  migrationMock: vi.fn(),
  coreEnqueueBatch: vi.fn(),
  coreAck: vi.fn(),
  coreDlq: vi.fn(),
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
    async enqueueOutboundBatch(jobs: Record<string, unknown>[]): Promise<string[]> {
      return state.coreEnqueueBatch(jobs);
    }
    async enqueueOutbound(job: Record<string, unknown>): Promise<void> {
      await this.enqueueOutboundBatch([job]);
    }
    async ack(type: string, messageId: string): Promise<void> {
      await state.coreAck(type, messageId);
    }
    async moveToDlq(type: string, data: unknown, reason: string): Promise<void> {
      await state.coreDlq(type, data, reason);
    }
    async *consumeOutbound(): AsyncIterable<{ messageId: string; job: Record<string, any> }> {
      for (const entry of state.entries) yield entry;
    }
  }

  return { RedisStreamsQueue: CoreRedisStreamsQueue };
});

import {
  DELAYED_OUTBOUND_MIN_DELAY_MS,
  DELAYED_OUTBOUND_PARK_RETRY_MS,
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
    meta: { visibility: "public" as const },
  };
}

describe("durable delayed outbound queue", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    state.entries.length = 0;
    state.evalMock.mockReset();
    state.migrationMock.mockReset().mockResolvedValue(0);
    state.coreEnqueueBatch.mockReset().mockResolvedValue(["1700000000000-0"]);
    state.coreAck.mockReset().mockResolvedValue(undefined);
    state.coreDlq.mockReset().mockResolvedValue(undefined);
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
    vi.unstubAllEnvs();
  });

  it("writes future replacements directly to delayed storage before the ready Stream", async () => {
    const queue = new RedisStreamsQueue({ redisUrl: "redis://test" } as any);
    state.evalMock.mockResolvedValue(0);
    await queue.connect();
    state.evalMock.mockClear();

    const before = Date.now();
    const job = outboundJob(before + DELAYED_OUTBOUND_MIN_DELAY_MS + 60_000);
    await queue.enqueueOutbound(job as any);

    expect(state.coreEnqueueBatch).not.toHaveBeenCalled();
    expect(state.evalMock).toHaveBeenCalledTimes(1);
    const [, options] = state.evalMock.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(options.keys).toEqual([
      "ap:queue:outbound:v1:delayed:v1",
      "ap:queue:outbound:v1:delayed-payload:v1",
    ]);
    const stored = JSON.parse(options.arguments[2] ?? "{}");
    expect(stored.jobId).toBe(job.jobId);
    expect(stored.meta.apdmFirstQueuedAtMs).toBeGreaterThanOrEqual(before);
    expect(stored.meta.apdmFirstQueuedAtMs).toBeLessThanOrEqual(Date.now());

    await queue.disconnect();
  });

  it("parks a ready future entry with its original Stream timestamp preserved", async () => {
    const queue = new RedisStreamsQueue({
      redisUrl: "redis://test",
      outboundStreamKey: "ap:queue:outbound:test",
      consumerGroup: "test-workers",
    } as any);
    state.evalMock.mockResolvedValue(0);
    await queue.connect();
    state.evalMock.mockClear();

    const streamMs = Date.now() - 1_000;
    const messageId = `${streamMs}-1`;
    const job = outboundJob(Date.now() + DELAYED_OUTBOUND_MIN_DELAY_MS + 60_000);
    state.entries.push({ messageId, job });

    const result = await queue.consumeOutbound()[Symbol.asyncIterator]().next();

    expect(result.done).toBe(true);
    const [, options] = state.evalMock.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    const stored = JSON.parse(options.arguments[2] ?? "{}");
    expect(stored.meta.apdmFirstQueuedAtMs).toBe(streamMs);
    expect(options.arguments[4]).toBe("test-workers");
    expect(options.arguments[5]).toBe(messageId);

    await queue.disconnect();
  });

  it("retries the same future source after a transient park failure before consuming later work", async () => {
    vi.useFakeTimers();
    const queue = new RedisStreamsQueue({ redisUrl: "redis://test" } as any);
    state.evalMock.mockResolvedValue(0);
    await queue.connect();
    state.evalMock.mockClear();
    state.evalMock
      .mockRejectedValueOnce(new Error("redis transient"))
      .mockResolvedValueOnce(1);

    const firstMs = Date.now();
    const firstMessageId = `${firstMs}-1`;
    const secondMessageId = `${firstMs + 1}-2`;
    state.entries.push({
      messageId: firstMessageId,
      job: outboundJob(firstMs + DELAYED_OUTBOUND_MIN_DELAY_MS + 60_000),
    });
    state.entries.push({
      messageId: secondMessageId,
      job: outboundJob(0),
    });

    const next = queue.consumeOutbound()[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(DELAYED_OUTBOUND_PARK_RETRY_MS);
    const result = await next;

    expect(result.done).toBe(false);
    expect(result.value?.messageId).toBe(secondMessageId);
    const parkCalls = state.evalMock.mock.calls.filter((call) => {
      const options = call[1] as { arguments?: string[] } | undefined;
      return options?.arguments?.length === 6;
    });
    expect(parkCalls).toHaveLength(2);
    const firstPark = parkCalls[0]?.[1] as { arguments: string[] };
    const retriedPark = parkCalls[1]?.[1] as { arguments: string[] };
    expect(firstPark.arguments[5]).toBe(firstMessageId);
    expect(retriedPark.arguments[5]).toBe(firstMessageId);
    expect(state.coreAck).not.toHaveBeenCalledWith("outbound", firstMessageId);

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
