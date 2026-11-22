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

import { RedisStreamsQueue, nextAutoClaimCursor } from "../sidecar-redis-queue.js";

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

  it("validates XAUTOCLAIM continuation rather than trusting an invalid cursor",()=>{
    expect(nextAutoClaimCursor({nextId:"12-3",messages:[]})).toBe("12-3");
    expect(nextAutoClaimCursor({nextId:"0-0",messages:[]})).toBe("0-0");
    expect(nextAutoClaimCursor({messages:[]})).toBe("0-0");
    expect(()=>nextAutoClaimCursor({nextId:"invalid"})).toThrow(/continuation/);
    expect(()=>nextAutoClaimCursor({nextId:42})).toThrow(/continuation/);
  });

  it("advances across bounded pending pages rather than repeatedly starting at 0-0",async()=>{
    const admin=makeClient();
    const inbound=makeClient({
      xAutoClaim:vi.fn()
        .mockResolvedValueOnce({nextId:"50-0",messages:[]})
        .mockResolvedValueOnce({nextId:"0-0",messages:[[
          "51-0",{
            envelopeId:"envelope-51",method:"POST",path:"/inbox",
            headers:"{}",body:"{\"type\":\"Create\"}",
            remoteIp:"127.0.0.1",receivedAt:"1",
            attempt:"0",notBeforeMs:"0",verification:"",
          },
        ]]}),
      xReadGroup:vi.fn().mockResolvedValue([]),
    });
    fakeClients.push(admin,inbound,makeClient(),makeClient(),makeClient());
    const queue=new RedisStreamsQueue({claimBatchCount:10,blockTimeoutMs:10});
    await queue.connect();
    const iterator=queue.consumeInbound()[Symbol.asyncIterator]();
    const result=await iterator.next();
    expect(result.value?.envelope.envelopeId).toBe("envelope-51");
    expect(inbound.xAutoClaim).toHaveBeenCalledTimes(2);
    expect(inbound.xAutoClaim.mock.calls[0]?.[4]).toBe("0-0");
    expect(inbound.xAutoClaim.mock.calls[1]?.[4]).toBe("50-0");
    await iterator.return?.();
    await queue.disconnect();
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
