const { secureRequestMock } = vi.hoisted(() => ({
  secureRequestMock: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("../../security/activitypub-egress-policy.js", () => ({
  secureActivityPubRequest: secureRequestMock,
  isUnsafeActivityPubTargetError: vi.fn(() => false),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundJob } from "../../queue/sidecar-redis-queue.js";
import { COLLECTION_SYNC_HEADER } from "../../federation/fep8fcf/CollectionSyncHeader.js";
import {
  MAX_RESPONSE_BODY_READ_BYTES,
  OutboundWorker,
  readBoundedResponseBody,
  type DeliveryResult,
  type OutboundWorkerConfig,
} from "../outbound-worker.js";

class TestOutboundWorker extends OutboundWorker {
  async deliverPublic(job: OutboundJob): Promise<DeliveryResult> {
    return this.deliver(job);
  }
}

function responseBody(chunks: Buffer[]) {
  const destroy = vi.fn();
  return {
    destroy,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeJob(activity: Record<string, unknown>): OutboundJob {
  return {
    jobId: "job-fallback-fep",
    activityId: "https://example.com/activities/1",
    actorUri: "https://example.com/users/alice",
    activity: JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://example.com/activities/1",
      type: "Create",
      actor: "https://example.com/users/alice",
      object: { id: "https://example.com/notes/1", type: "Note", content: "hello" },
      ...activity,
    }),
    targetInbox: "http://localhost:8080/inbox",
    targetDomain: "localhost",
    attempt: 0,
    maxAttempts: 5,
    notBeforeMs: 0,
    meta: {
      // Deliberately public: FEP eligibility must come from ActivityPub
      // recipients, not this sidecar-only classification.
      visibility: "public",
      apdmFirstQueuedAtMs: Date.now(),
    } as any,
  };
}

function makeWorker(buildSenderHeader = vi.fn().mockResolvedValue("sync-value")) {
  const signingClient = {
    signOne: vi.fn().mockResolvedValue({
      ok: true,
      signedHeaders: {
        date: "Sun, 16 Aug 2026 12:00:00 GMT",
        digest: "SHA-256=xyz",
        signature: "keyId=\"test\",signature=\"abc\"",
      },
    }),
  } as any;

  const config: OutboundWorkerConfig = {
    concurrency: 1,
    maxConcurrentPerDomain: 2,
    requestTimeoutMs: 5_000,
    userAgent: "Fallback-FEP-Test/1.0",
    fedifyRuntimeIntegrationEnabled: false,
    domain: "example.com",
    followersSyncService: { buildSenderHeader } as any,
  };

  return {
    worker: new TestOutboundWorker({} as any, signingClient, {} as any, config),
    buildSenderHeader,
  };
}

describe("OutboundWorker fallback FEP-8fcf delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureRequestMock.mockReset();
    secureRequestMock.mockResolvedValue({
      statusCode: 202,
      headers: {},
      body: responseBody([Buffer.from("accepted")]),
    });
  });

  it("adds synchronization for a public activity actually addressed to followers", async () => {
    const { worker, buildSenderHeader } = makeWorker();
    const job = makeJob({
      to: "https://www.w3.org/ns/activitystreams#Public",
      cc: ["https://example.com/users/alice/followers"],
    });

    const result = await worker.deliverPublic(job);

    expect(result).toMatchObject({ success: true, statusCode: 202 });
    expect(buildSenderHeader).toHaveBeenCalledWith(
      "alice",
      "https://example.com/users/alice/followers",
      job.targetInbox,
    );
    const requestOptions = secureRequestMock.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(requestOptions.headers?.[COLLECTION_SYNC_HEADER]).toBe("sync-value");
  });

  it("does not add synchronization when the wire activity does not address followers", async () => {
    const { worker, buildSenderHeader } = makeWorker();
    const result = await worker.deliverPublic(makeJob({
      to: "https://www.w3.org/ns/activitystreams#Public",
    }));

    expect(result).toMatchObject({ success: true, statusCode: 202 });
    expect(buildSenderHeader).not.toHaveBeenCalled();
    const requestOptions = secureRequestMock.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(requestOptions.headers?.[COLLECTION_SYNC_HEADER]).toBeUndefined();
  });

  it("keeps ordinary delivery working when optional synchronization authority fails", async () => {
    const buildSenderHeader = vi.fn().mockRejectedValue(new Error("authority unavailable"));
    const { worker } = makeWorker(buildSenderHeader);
    const result = await worker.deliverPublic(makeJob({
      cc: ["https://example.com/users/alice/followers"],
    }));

    expect(result).toMatchObject({ success: true, statusCode: 202 });
    expect(secureRequestMock).toHaveBeenCalledTimes(1);
    const requestOptions = secureRequestMock.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(requestOptions.headers?.[COLLECTION_SYNC_HEADER]).toBeUndefined();
  });

  it("bounds diagnostic response reads and destroys an oversized body", async () => {
    const body = responseBody([Buffer.alloc(MAX_RESPONSE_BODY_READ_BYTES + 4096, 0x61)]);
    const text = await readBoundedResponseBody(body);

    expect(Buffer.byteLength(text, "utf8")).toBe(MAX_RESPONSE_BODY_READ_BYTES);
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not destroy a response body that completes within the read bound", async () => {
    const body = responseBody([Buffer.from("small response")]);
    await expect(readBoundedResponseBody(body)).resolves.toBe("small response");
    expect(body.destroy).not.toHaveBeenCalled();
  });
});
