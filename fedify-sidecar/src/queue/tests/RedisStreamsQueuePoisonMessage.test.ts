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
  xAdd: ReturnType<typeof vi.fn>;
  xAck: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
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
    xPending: vi.fn().mockResolvedValue({ pending: 0 }),
    xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
    xReadGroup: vi.fn().mockResolvedValue([]),
    xAdd: vi.fn().mockResolvedValue("dlq-1"),
    xAck: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function validOutboundFields(): Record<string, string> {
  return {
    jobId: "job-valid",
    activityId: "https://local.example/activities/1",
    actorUri: "https://local.example/users/alice",
    activity: JSON.stringify({ type: "Create", id: "https://local.example/activities/1" }),
    targetInbox: "https://remote.example/inbox",
    targetDomain: "remote.example",
    attempt: "0",
    maxAttempts: "8",
    notBeforeMs: "0",
    deferCount: "0",
    lastError: "",
    meta: "",
  };
}

describe("RedisStreamsQueue poison-message recovery", () => {
  beforeEach(() => {
    fakeClients.length = 0;
  });

  it("atomically quarantines a malformed reclaimed entry and still yields the valid entry behind it", async () => {
    const malformed = validOutboundFields();
    delete malformed.jobId;

    const adminClient = makeClient();
    const inboundConsumer = makeClient();
    const outboundConsumer = makeClient({
      xAutoClaim: vi.fn().mockResolvedValue({
        messages: [
          ["100-0", malformed],
          ["101-0", validOutboundFields()],
        ],
      }),
    });
    const outboxIntentConsumer = makeClient();
    const originReconcileConsumer = makeClient();
    fakeClients.push(adminClient, inboundConsumer, outboundConsumer, outboxIntentConsumer, originReconcileConsumer);

    const queue = new RedisStreamsQueue({ claimIdleTimeMs: 1 });
    await queue.connect();

    const iterator = queue.consumeOutbound()[Symbol.asyncIterator]();
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("valid job was stranded behind poison entry")), 250)),
    ]);

    expect(result.done).toBe(false);
    expect(result.value?.messageId).toBe("101-0");
    expect(result.value?.job.jobId).toBe("job-valid");

    expect(adminClient.eval).toHaveBeenCalledTimes(1);
    const [script, invocation] = adminClient.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];
    expect(script.indexOf("XADD")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("XACK")).toBeGreaterThan(script.indexOf("XADD"));
    expect(invocation.keys).toEqual([
      "ap:queue:dlq:outbound:v1",
      "ap:queue:outbound:v1",
    ]);
    expect(invocation.arguments[1]).toBe("outbound");
    expect(invocation.arguments[2]).toBe("100-0");
    expect(invocation.arguments[3]).toMatch(/malformed.*jobId/iu);
    expect(invocation.arguments[6]).toBe("sidecar-workers");

    const diagnostic = JSON.parse(invocation.arguments[5] ?? "null");
    expect(diagnostic).toEqual(expect.objectContaining({
      streamMessageId: "100-0",
      fieldNames: expect.arrayContaining(["activity", "activityId", "actorUri", "targetInbox"]),
      fieldCount: expect.any(Number),
      payloadBytes: expect.any(Number),
    }));
    expect(diagnostic).not.toHaveProperty("fields");
    expect(invocation.arguments[5]).not.toContain("https://local.example/activities/1");

    await iterator.return?.();
    await queue.disconnect();
  });

  it("leaves a malformed source pending when the atomic DLQ-and-ACK transition fails", async () => {
    const adminClient = makeClient({ eval: vi.fn().mockRejectedValue(new Error("redis quarantine transaction failed")) });
    const inboundConsumer = makeClient();
    const outboundConsumer = makeClient();
    const outboxIntentConsumer = makeClient();
    const originReconcileConsumer = makeClient();
    fakeClients.push(adminClient, inboundConsumer, outboundConsumer, outboxIntentConsumer, originReconcileConsumer);

    const queue = new RedisStreamsQueue();
    await queue.connect();

    await expect(
      (queue as any).quarantineMalformedStreamMessage(
        "outbound",
        "200-0",
        { activity: "sensitive body", targetInbox: "https://remote.example/inbox" },
        new Error("invalid job"),
      ),
    ).rejects.toThrow(/redis quarantine transaction failed/u);

    expect(adminClient.xAck).not.toHaveBeenCalled();
    await queue.disconnect();
  });

  it("strictly quarantines non-canonical integer fields instead of accepting parseInt prefixes", async () => {
    const malformed = validOutboundFields();
    malformed.attempt = "1junk";

    const adminClient = makeClient();
    const inboundConsumer = makeClient();
    const outboundConsumer = makeClient({
      xAutoClaim: vi.fn().mockResolvedValue({ messages: [["300-0", malformed], ["301-0", validOutboundFields()]] }),
    });
    const outboxIntentConsumer = makeClient();
    const originReconcileConsumer = makeClient();
    fakeClients.push(adminClient, inboundConsumer, outboundConsumer, outboxIntentConsumer, originReconcileConsumer);

    const queue = new RedisStreamsQueue({ claimIdleTimeMs: 1 });
    await queue.connect();

    const iterator = queue.consumeOutbound()[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.value?.messageId).toBe("301-0");

    const [, invocation] = adminClient.eval.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(invocation.arguments[2]).toBe("300-0");
    expect(invocation.arguments[3]).toMatch(/invalid integer field attempt/iu);

    await iterator.return?.();
    await queue.disconnect();
  });
});
