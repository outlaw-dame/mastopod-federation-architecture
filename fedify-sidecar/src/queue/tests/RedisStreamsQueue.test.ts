vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeRedisClient = {
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  xGroupCreate: ReturnType<typeof vi.fn>;
  xPending: ReturnType<typeof vi.fn>;
  xAutoClaim: ReturnType<typeof vi.fn>;
  xReadGroup: ReturnType<typeof vi.fn>;
};

const fakeClients: FakeRedisClient[] = [];

vi.mock("redis", () => ({
  createClient: vi.fn(() => {
    const client = fakeClients.shift();
    if (!client) {
      throw new Error("No fake Redis client available for test");
    }
    return client;
  }),
}));

import { RedisStreamsQueue } from "../sidecar-redis-queue.js";

function makeClient(overrides: Partial<FakeRedisClient> = {}): FakeRedisClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    xGroupCreate: vi.fn().mockResolvedValue("OK"),
    xPending: vi.fn().mockResolvedValue({ pending: 0 }),
    xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
    xReadGroup: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("RedisStreamsQueue", () => {
  beforeEach(() => {
    fakeClients.length = 0;
  });

  it("recreates the inbound consumer group after Redis loses stream groups", async () => {
    const adminClient = makeClient();
    const inboundConsumer = makeClient({
      xAutoClaim: vi.fn()
        .mockRejectedValueOnce(new Error("NOGROUP No such key 'ap:queue:inbound:v1' or consumer group 'sidecar-workers'"))
        .mockResolvedValueOnce({
          messages: [[
            "1-0",
            {
              envelopeId: "env-1",
              method: "POST",
              path: "/inbox",
              headers: "{}",
              body: "{\"type\":\"Accept\"}",
              remoteIp: "127.0.0.1",
              receivedAt: "1",
              attempt: "0",
              notBeforeMs: "0",
              verification: "",
            },
          ]],
        }),
    });
    const outboundConsumer = makeClient();
    const outboxIntentConsumer = makeClient();
    const originReconcileConsumer = makeClient();
    fakeClients.push(
      adminClient,
      inboundConsumer,
      outboundConsumer,
      outboxIntentConsumer,
      originReconcileConsumer,
    );

    const queue = new RedisStreamsQueue();
    await queue.connect();
    adminClient.xGroupCreate.mockClear();

    const iterator = queue.consumeInbound()[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.done).toBe(false);
    expect(result.value?.envelope.envelopeId).toBe("env-1");
    expect(adminClient.xGroupCreate).toHaveBeenCalledWith(
      "ap:queue:inbound:v1",
      "sidecar-workers",
      "0",
      { MKSTREAM: true },
    );

    await queue.disconnect();
  });

  it("recreates a missing consumer group when checking pending counts", async () => {
    const adminClient = makeClient({
      xPending: vi.fn()
        .mockRejectedValueOnce(new Error("NOGROUP No such key 'ap:queue:outbound:v1' or consumer group 'sidecar-workers'"))
        .mockResolvedValueOnce({ pending: 0 }),
    });
    const inboundConsumer = makeClient();
    const outboundConsumer = makeClient();
    const outboxIntentConsumer = makeClient();
    const originReconcileConsumer = makeClient();
    fakeClients.push(
      adminClient,
      inboundConsumer,
      outboundConsumer,
      outboxIntentConsumer,
      originReconcileConsumer,
    );

    const queue = new RedisStreamsQueue();
    await queue.connect();
    adminClient.xGroupCreate.mockClear();

    await expect(queue.getPendingCount("outbound")).resolves.toBe(0);
    expect(adminClient.xGroupCreate).toHaveBeenCalledWith(
      "ap:queue:outbound:v1",
      "sidecar-workers",
      "0",
      { MKSTREAM: true },
    );

    await queue.disconnect();
  });
});
