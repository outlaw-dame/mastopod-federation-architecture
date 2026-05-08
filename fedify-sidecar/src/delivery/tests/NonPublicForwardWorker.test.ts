import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("undici", () => ({
  request: requestMock,
}));

import {
  NonPublicForwardWorker,
  type NonPublicForwardWorkerConfig,
} from "../nonpublic-forward-worker.js";
import type { NonPublicForwardJob } from "../../queue/sidecar-redis-queue.js";

class TestNonPublicForwardWorker extends NonPublicForwardWorker {
  async runJob(messageId: string, job: NonPublicForwardJob): Promise<void> {
    return this.processJob(messageId, job);
  }
}

function makeJob(overrides: Partial<NonPublicForwardJob> = {}): NonPublicForwardJob {
  return {
    jobId: "npf-001",
    envelopeId: "env-001",
    activityId: "https://remote.example/activities/1",
    path: "/users/alice/inbox",
    headers: {},
    remoteIp: "127.0.0.1",
    receivedAt: Date.now() - 100,
    verifiedActorUri: "https://remote.example/users/bob",
    activity: JSON.stringify({
      id: "https://remote.example/activities/1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: { id: "https://remote.example/objects/1", type: "Note", content: "hi" },
    }),
    scope: "followers",
    createdAt: Date.now() - 100,
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
    ...overrides,
  };
}

function makeQueue(overrides: Record<string, unknown> = {}) {
  return {
    consumeNonPublicForwards: async function* () {},
    ack: vi.fn().mockResolvedValue(undefined),
    enqueueNonPublicForward: vi.fn().mockResolvedValue("msg-retry-1"),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeConfig(overrides: Partial<NonPublicForwardWorkerConfig> = {}): NonPublicForwardWorkerConfig {
  return {
    concurrency: 1,
    activityPodsUrl: "http://activitypods.local",
    activityPodsToken: "secret",
    requestTimeoutMs: 30_000,
    maxActivityBytes: 512 * 1024,
    maxJobAgeMs: 60 * 60 * 1000,
    deferSleepCapMs: 0,
    ...overrides,
  };
}

describe("NonPublicForwardWorker", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("acks successful non-public forwards", async () => {
    const queue = makeQueue();
    const worker = new TestNonPublicForwardWorker(queue, makeConfig());

    requestMock.mockResolvedValue({
      statusCode: 202,
      body: { text: vi.fn().mockResolvedValue("accepted") },
    });

    await worker.runJob("msg-001", makeJob());

    expect(queue.ack).toHaveBeenCalledWith("nonpublic_forward", "msg-001");
    expect(queue.enqueueNonPublicForward).not.toHaveBeenCalled();
    expect(queue.moveToDlq).not.toHaveBeenCalled();
  });

  it("retries transient failures with backoff", async () => {
    const queue = makeQueue();
    const worker = new TestNonPublicForwardWorker(queue, makeConfig());

    requestMock.mockResolvedValue({
      statusCode: 503,
      body: { text: vi.fn().mockResolvedValue("unavailable") },
    });

    const before = Date.now();
    await worker.runJob("msg-002", makeJob());

    expect(queue.ack).toHaveBeenCalledWith("nonpublic_forward", "msg-002");
    expect(queue.enqueueNonPublicForward).toHaveBeenCalledTimes(1);
    expect(queue.moveToDlq).not.toHaveBeenCalled();

    const retried = queue.enqueueNonPublicForward.mock.calls[0]?.[0] as NonPublicForwardJob;
    expect(retried.attempt).toBe(1);
    expect(retried.notBeforeMs).toBeGreaterThan(before);
  });

  it("sends invalid payloads to DLQ as permanent failures", async () => {
    const queue = makeQueue();
    const worker = new TestNonPublicForwardWorker(queue, makeConfig());

    await worker.runJob("msg-003", makeJob({ activity: "{not-json" }));

    expect(queue.ack).toHaveBeenCalledWith("nonpublic_forward", "msg-003");
    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    expect(queue.enqueueNonPublicForward).not.toHaveBeenCalled();
  });

  it("rejects unsafe target paths to DLQ", async () => {
    const queue = makeQueue();
    const worker = new TestNonPublicForwardWorker(queue, makeConfig());

    await worker.runJob("msg-004", makeJob({ path: "/../etc/passwd" }));

    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    expect(queue.enqueueNonPublicForward).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("drops stale jobs to DLQ", async () => {
    const queue = makeQueue();
    const worker = new TestNonPublicForwardWorker(queue, makeConfig({ maxJobAgeMs: 1 }));

    await worker.runJob(
      "msg-005",
      makeJob({ createdAt: Date.now() - 10_000, receivedAt: Date.now() - 10_000 }),
    );

    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    const reason = queue.moveToDlq.mock.calls[0]?.[2];
    expect(reason).toContain("stale");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("re-enqueues before acking when defer wait exceeds sleep cap", async () => {
    const queue = makeQueue();
    const worker = new TestNonPublicForwardWorker(
      queue,
      makeConfig({ deferSleepCapMs: 0 }),
    );

    const job = makeJob({ notBeforeMs: Date.now() + 60_000 });
    await worker.runJob("msg-006", job);

    expect(queue.enqueueNonPublicForward).toHaveBeenCalledTimes(1);
    expect(queue.ack).toHaveBeenCalledWith("nonpublic_forward", "msg-006");

    const enqueueOrder = queue.enqueueNonPublicForward.mock.invocationCallOrder[0];
    const ackOrder = queue.ack.mock.invocationCallOrder[0];
    expect(enqueueOrder).toBeLessThan(ackOrder);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
