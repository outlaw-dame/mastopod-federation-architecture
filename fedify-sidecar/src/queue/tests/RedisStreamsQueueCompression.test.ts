vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisStreamPayloadCodec } from "../redis-stream-payload-codec.js";

type FakeRedisClient = {
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  xGroupCreate: ReturnType<typeof vi.fn>;
  xAutoClaim: ReturnType<typeof vi.fn>;
  xReadGroup: ReturnType<typeof vi.fn>;
  xAdd: ReturnType<typeof vi.fn>;
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

import {
  RedisStreamsQueue,
  type OutboundJob,
  type OutboxIntent,
} from "../sidecar-redis-queue-core.js";

function makeClient(overrides: Partial<FakeRedisClient> = {}): FakeRedisClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    xGroupCreate: vi.fn().mockResolvedValue("OK"),
    xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
    xReadGroup: vi.fn().mockResolvedValue([]),
    xAdd: vi.fn().mockResolvedValue("1-0"),
    eval: vi.fn().mockResolvedValue(["1", "1"]),
    ...overrides,
  };
}

function installClients(overrides: {
  admin?: Partial<FakeRedisClient>;
  outbound?: Partial<FakeRedisClient>;
  outboxIntent?: Partial<FakeRedisClient>;
} = {}): {
  admin: FakeRedisClient;
  outbound: FakeRedisClient;
  outboxIntent: FakeRedisClient;
} {
  const admin = makeClient(overrides.admin);
  const inbound = makeClient();
  const outbound = makeClient(overrides.outbound);
  const outboxIntent = makeClient(overrides.outboxIntent);
  const origin = makeClient();
  fakeClients.push(admin, inbound, outbound, outboxIntent, origin);
  return { admin, outbound, outboxIntent };
}

const activity = JSON.stringify({
  id: "https://local.example/activities/1",
  type: "Create",
  actor: "https://local.example/users/alice",
  object: { type: "Note", content: "activitypub ".repeat(3000) },
});

const targets = [{
  inboxUrl: "https://remote.example/users/bob/inbox",
  deliveryUrl: "https://remote.example/inbox",
  sharedInboxUrl: "https://remote.example/inbox",
  targetDomain: "remote.example",
}];

function makeIntent(): OutboxIntent {
  return {
    intentId: "intent-1",
    activityId: "https://local.example/activities/1",
    actorUri: "https://local.example/users/alice",
    activity,
    targets,
    createdAt: 1,
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
  };
}

function makeJob(index: number): OutboundJob {
  return {
    jobId: `job-${index}`,
    activityId: "https://local.example/activities/1",
    actorUri: "https://local.example/users/alice",
    activity,
    targetInbox: `https://remote-${index}.example/inbox`,
    targetDomain: `remote-${index}.example`,
    attempt: 0,
    maxAttempts: 10,
    notBeforeMs: 0,
  };
}

describe("RedisStreamsQueue compression boundary", () => {
  beforeEach(() => {
    fakeClients.length = 0;
  });

  it("keeps ready Stream writes plaintext by default", async () => {
    const { admin } = installClients();
    const queue = new RedisStreamsQueue();
    await queue.connect();

    await queue.enqueueOutboxIntent(makeIntent());

    const fields = admin.xAdd.mock.calls[0]?.[2] as Record<string, string>;
    expect(fields["activity"]).toBe(activity);
    expect(fields["targets"]).toBe(JSON.stringify(targets));
    await queue.disconnect();
  });

  it("compresses Activity and target fields only when explicitly enabled", async () => {
    const { admin } = installClients();
    const queue = new RedisStreamsQueue({
      payloadCompression: { writeEnabled: true, minBytes: 1 },
    });
    await queue.connect();

    await queue.enqueueOutboxIntent(makeIntent());

    const fields = admin.xAdd.mock.calls[0]?.[2] as Record<string, string>;
    expect(fields["activity"]).toMatch(/^apq1:br:/u);
    expect(fields["targets"]).toMatch(/^apq1:br:/u);
    await queue.disconnect();
  });

  it("decodes compressed outbox-intent fields back into the unchanged in-memory contract", async () => {
    const encoder = new RedisStreamPayloadCodec({ writeEnabled: true, minBytes: 1 });
    const compressedActivity = encoder.encode(activity).value;
    const compressedTargets = encoder.encode(JSON.stringify(targets)).value;
    const { outboxIntent } = installClients({
      outboxIntent: {
        xAutoClaim: vi.fn().mockResolvedValue({
          messages: [["1-0", {
            intentId: "intent-1",
            activityId: "https://local.example/activities/1",
            actorUri: "https://local.example/users/alice",
            activity: compressedActivity,
            targets: compressedTargets,
            createdAt: "1",
            attempt: "0",
            maxAttempts: "8",
            notBeforeMs: "0",
            lastError: "",
            meta: "",
            bridgeHints: "",
          }]],
        }),
      },
    });
    const queue = new RedisStreamsQueue();
    await queue.connect();

    const iterator = queue.consumeOutboxIntents()[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.value?.intent.activity).toBe(activity);
    expect(result.value?.intent.targets).toEqual(targets);
    expect(outboxIntent.xAutoClaim).toHaveBeenCalled();
    await queue.disconnect();
  });

  it("decodes compressed outbound jobs for workers that never see the storage envelope", async () => {
    const encoder = new RedisStreamPayloadCodec({ writeEnabled: true, minBytes: 1 });
    const compressedActivity = encoder.encode(activity).value;
    installClients({
      outbound: {
        xAutoClaim: vi.fn().mockResolvedValue({
          messages: [["1-0", {
            jobId: "job-1",
            activityId: "https://local.example/activities/1",
            actorUri: "https://local.example/users/alice",
            activity: compressedActivity,
            targetInbox: "https://remote.example/inbox",
            targetDomain: "remote.example",
            attempt: "0",
            maxAttempts: "10",
            notBeforeMs: "0",
            deferCount: "0",
            lastError: "",
            meta: "",
          }]],
        }),
      },
    });
    const queue = new RedisStreamsQueue();
    await queue.connect();

    const iterator = queue.consumeOutbound()[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.value?.job.activity).toBe(activity);
    await queue.disconnect();
  });

  it("uses one identical encoded Activity representation across atomic fanout arguments", async () => {
    const { admin } = installClients({
      admin: { eval: vi.fn().mockResolvedValue(["1", "2"]) },
    });
    const queue = new RedisStreamsQueue({
      payloadCompression: { writeEnabled: true, minBytes: 1 },
    });
    await queue.connect();

    await queue.enqueueOutboundBatchForIntent("intent-1", [makeJob(1), makeJob(2)]);

    const options = admin.eval.mock.calls[0]?.[1] as { arguments: string[] };
    const args = options.arguments;
    const firstActivity = args[6];
    const secondActivity = args[18];
    expect(firstActivity).toMatch(/^apq1:br:/u);
    expect(secondActivity).toBe(firstActivity);
    await queue.disconnect();
  });
});
