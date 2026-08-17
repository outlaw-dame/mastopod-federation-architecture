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

  it("quarantines a malformed reclaimed entry and still yields the valid entry behind it", async () => {
    const adminClient = makeClient();
    const inboundConsumer = makeClient();
    const outboundConsumer = makeClient({
      xAutoClaim: vi.fn().mockResolvedValue({
        messages: [
          ["100-0", { ...validOutboundFields(), jobId: undefined }],
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

    expect(adminClient.xAdd).toHaveBeenCalledTimes(1);
    expect(adminClient.xAdd).toHaveBeenCalledWith(
      "ap:queue:dlq:outbound:v1",
      "*",
      expect.objectContaining({
        id: "100-0",
        reason: expect.stringMatching(/malformed.*jobId/iu),
      }),
      expect.objectContaining({ TRIM: expect.any(Object) }),
    );
    expect(adminClient.xAck).toHaveBeenCalledWith("ap:queue:outbound:v1", "sidecar-workers", "100-0");

    const dlqFields = adminClient.xAdd.mock.calls[0]?.[2] as Record<string, string>;
    const diagnostic = JSON.parse(dlqFields.data);
    expect(diagnostic).toEqual(expect.objectContaining({
      streamMessageId: "100-0",
      fieldNames: expect.arrayContaining(["activity", "activityId", "actorUri", "targetInbox"]),
    }));
    expect(diagnostic).not.toHaveProperty("fields");
    expect(dlqFields.data).not.toContain("https://local.example/activities/1");

    await iterator.return?.();
    await queue.disconnect();
  });

  it("never ACKs a malformed source entry when DLQ persistence fails", async () => {
    const adminClient = makeClient({ xAdd: vi.fn().mockRejectedValue(new Error("redis dlq write failed")) });
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
    ).rejects.toThrow(/redis dlq write failed/u);

    expect(adminClient.xAck).not.toHaveBeenCalled();
    await queue.disconnect();
  });
});
