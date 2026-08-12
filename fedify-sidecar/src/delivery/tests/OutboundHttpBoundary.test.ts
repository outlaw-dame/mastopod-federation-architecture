vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import type { OutboundJob } from "../../queue/sidecar-redis-queue.js";
import {
  APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS,
} from "../apdm-replay-horizon.js";
import {
  OutboundResidenceExpiredError,
  OutboundWorker,
} from "../outbound-worker.js";

class BoundaryWorker extends OutboundWorker {
  async runDeliver(job: OutboundJob) {
    return this.deliver(job);
  }
}

function outboundJob(firstQueuedAtMs: number): OutboundJob {
  return {
    jobId: "https://local.example/activities/1::https://remote.example/inbox",
    activityId: "https://local.example/activities/1",
    actorUri: "https://local.example/users/alice",
    activity: JSON.stringify({ type: "Create" }),
    targetInbox: "https://remote.example/inbox",
    targetDomain: "remote.example",
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
    meta: {
      visibility: "public",
      apdmFirstQueuedAtMs: firstQueuedAtMs,
    },
  };
}

describe("APDM native outbound HTTP boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not POST when signing crosses the preserved residence deadline", async () => {
    vi.useFakeTimers();
    const nowMs = 2_000_000_000_000;
    vi.setSystemTime(nowMs);
    const firstQueuedAtMs = nowMs - APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS + 1;

    const signingClient = {
      signOne: vi.fn().mockImplementation(async () => {
        vi.setSystemTime(nowMs + 2);
        return {
          ok: true,
          signedHeaders: {
            date: "Sun, 05 Apr 2026 12:00:00 GMT",
            digest: "SHA-256=xyz",
            signature: "keyId=\"test\",signature=\"abc\"",
          },
        };
      }),
    };
    const worker = new BoundaryWorker(
      {} as any,
      signingClient as any,
      {} as any,
      {
        concurrency: 1,
        maxConcurrentPerDomain: 1,
        requestTimeoutMs: 5_000,
        userAgent: "APDM-Test/1.0",
        fedifyRuntimeIntegrationEnabled: false,
      },
    );

    await expect(worker.runDeliver(outboundJob(firstQueuedAtMs))).rejects.toBeInstanceOf(
      OutboundResidenceExpiredError,
    );

    expect(signingClient.signOne).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
});
