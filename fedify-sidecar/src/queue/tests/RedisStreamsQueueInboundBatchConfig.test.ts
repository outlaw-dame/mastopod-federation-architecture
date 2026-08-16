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
  xAutoClaim: ReturnType<typeof vi.fn>;
  xReadGroup: ReturnType<typeof vi.fn>;
};

const fakeClients: FakeRedisClient[] = [];

vi.mock("redis", () => ({
  createClient: vi.fn(() => {
    const client = fakeClients.shift();
    if (!client) throw new Error("No fake Redis client available for test");
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
    xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
    xReadGroup: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function inboundFields(envelopeId: string): Record<string, string> {
  return {
    envelopeId,
    method: "POST",
    path: "/inbox",
    headers: "{}",
    body: "{\"type\":\"Create\"}",
    remoteIp: "127.0.0.1",
    receivedAt: "1",
    attempt: "0",
    notBeforeMs: "0",
    verification: "",
  };
}

function installClients(inboundConsumer: FakeRedisClient): void {
  fakeClients.push(
    makeClient(),
    inboundConsumer,
    makeClient(),
    makeClient(),
    makeClient(),
  );
}

describe("RedisStreamsQueue inbound batch configuration", () => {
  beforeEach(() => {
    fakeClients.length = 0;
  });

  it("uses configured claimBatchCount for inbound XAUTOCLAIM", async () => {
    const inboundConsumer = makeClient({
      xAutoClaim: vi.fn().mockResolvedValue({
        messages: [["1-0", inboundFields("claimed-env")]],
      }),
    });
    installClients(inboundConsumer);

    const queue = new RedisStreamsQueue({ claimBatchCount: 37, readBatchCount: 19 });
    await queue.connect();

    const iterator = queue.consumeInbound()[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.value?.envelope.envelopeId).toBe("claimed-env");
    expect(inboundConsumer.xAutoClaim).toHaveBeenCalledWith(
      "ap:queue:inbound:v1",
      "sidecar-workers",
      expect.any(String),
      60_000,
      "0-0",
      { COUNT: 37 },
    );
    expect(inboundConsumer.xReadGroup).not.toHaveBeenCalled();

    await iterator.return?.();
    await queue.disconnect();
  });

  it("uses configured readBatchCount for inbound XREADGROUP", async () => {
    const inboundConsumer = makeClient({
      xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
      xReadGroup: vi.fn().mockResolvedValue([
        ["ap:queue:inbound:v1", [["2-0", inboundFields("new-env")]]],
      ]),
    });
    installClients(inboundConsumer);

    const queue = new RedisStreamsQueue({ claimBatchCount: 31, readBatchCount: 23 });
    await queue.connect();

    const iterator = queue.consumeInbound()[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.value?.envelope.envelopeId).toBe("new-env");
    expect(inboundConsumer.xReadGroup).toHaveBeenCalledWith(
      "sidecar-workers",
      expect.any(String),
      { key: "ap:queue:inbound:v1", id: ">" },
      { COUNT: 23, BLOCK: 5_000 },
    );

    await iterator.return?.();
    await queue.disconnect();
  });
});
