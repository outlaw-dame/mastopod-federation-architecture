vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import {
  OriginReconciliationWorker,
  type OriginReconciliationWorkerConfig,
} from "../origin-reconciliation-worker.js";
import type { OriginReconciliationJob } from "../../queue/sidecar-redis-queue.js";

class TestOriginReconciliationWorker extends OriginReconciliationWorker {
  async runJob(messageId: string, job: OriginReconciliationJob): Promise<void> {
    return this.processJob(messageId, job);
  }
}

function makeJob(overrides: Partial<OriginReconciliationJob> = {}): OriginReconciliationJob {
  return {
    jobId: "reconcile-001",
    originObjectUrl: "https://remote.example/objects/1",
    canonicalObjectId: "https://remote.example/objects/1",
    actorUriHint: "https://remote.example/users/alice",
    reason: "conversation-hydration",
    createdAt: Date.now() - 100,
    attempt: 0,
    maxAttempts: 5,
    notBeforeMs: 0,
    windowExpiresAt: Date.now() + 30 * 60 * 1000,
    lastFingerprint: "initial-fingerprint",
    unchangedSuccesses: 0,
    notFoundCount: 0,
    ...overrides,
  };
}

function makeQueue(overrides: Record<string, unknown> = {}) {
  return {
    consumeOriginReconciliation: async function* () {},
    ack: vi.fn().mockResolvedValue(undefined),
    enqueueOriginReconciliation: vi.fn().mockResolvedValue("msg-2"),
    enqueueInbound: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    checkDomainRateLimit: vi.fn().mockResolvedValue(true),
    acquireDomainSlot: vi.fn().mockResolvedValue(true),
    releaseDomainSlot: vi.fn().mockResolvedValue(undefined),
    markOriginReconciliationApplied: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as any;
}

function makeSigningClient() {
  return {
    signOne: vi.fn().mockResolvedValue({
      ok: true,
      signedHeaders: {
        date: "Thu, 01 Jan 2025 00:00:00 GMT",
        signature: "sig=mock",
      },
    }),
  } as any;
}

function makeConfig(overrides: Partial<OriginReconciliationWorkerConfig> = {}): OriginReconciliationWorkerConfig {
  return {
    concurrency: 1,
    signerActorUri: "https://social.example/users/relay",
    requestTimeoutMs: 5000,
    requestRetries: 0,
    requestRetryBaseDelayMs: 100,
    requestRetryMaxDelayMs: 1000,
    userAgent: "Fedify-Sidecar/Test",
    perOriginConcurrency: 2,
    perOriginBurstLimit: 5,
    perOriginBurstWindowSeconds: 300,
    maxUnchangedSuccesses: 2,
    applyIdempotencyTtlSeconds: 600,
    ...overrides,
  };
}

describe("OriginReconciliationWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues a synthetic inbound update when origin content changes", async () => {
    const queue = makeQueue();
    const signingClient = makeSigningClient();
    const worker = new TestOriginReconciliationWorker(queue, signingClient, makeConfig());

    (request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          id: "https://remote.example/objects/1",
          type: "Note",
          attributedTo: "https://remote.example/users/alice",
          content: "Updated content",
        }));
      })(),
    } as any);

    await worker.runJob("msg-1", makeJob());

    expect(queue.enqueueInbound).toHaveBeenCalledTimes(1);
    expect(queue.enqueueOriginReconciliation).toHaveBeenCalledTimes(1);
    expect(queue.markOriginReconciliationApplied).toHaveBeenCalledTimes(1);
    expect(queue.ack).toHaveBeenCalledWith("origin_reconcile", "msg-1");
  });

  it("stops after repeated unchanged fetches", async () => {
    const queue = makeQueue();
    const signingClient = makeSigningClient();
    const worker = new TestOriginReconciliationWorker(queue, signingClient, makeConfig());

    const stableBody = {
      id: "https://remote.example/objects/1",
      type: "Note",
      attributedTo: "https://remote.example/users/alice",
      content: "Stable content",
    };
    const stableFingerprint = createStableFingerprint(stableBody);

    (request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(JSON.stringify(stableBody));
      })(),
    } as any);

    await worker.runJob("msg-2", makeJob({ lastFingerprint: stableFingerprint, unchangedSuccesses: 1 }));

    expect(queue.enqueueInbound).not.toHaveBeenCalled();
    expect(queue.enqueueOriginReconciliation).not.toHaveBeenCalled();
    expect(queue.ack).toHaveBeenCalledWith("origin_reconcile", "msg-2");
  });
});

function createStableFingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}