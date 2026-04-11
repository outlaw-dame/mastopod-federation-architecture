/**
 * FederationRuntimeAdapter Parity Tests
 *
 * Validates that the integration adapter hooks are:
 *  1. Never called when the flag is OFF (NoopFederationRuntimeAdapter)
 *  2. Called with the correct payload when the flag is ON
 *  3. Errors thrown by the adapter are swallowed and never propagate
 *     to the host business-logic path
 *
 * These tests run fully in-process — no Redis, no Kafka, no live endpoints.
 */

// Mock the logger before any module that imports it is loaded.
// winston is a runtime-only dependency not installed for tests.
vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InboundWorker,
  InboundWorkerConfig,
  createInboundWorker,
} from "../inbound-worker.js";
import {
  OutboundWorker,
  OutboundWorkerConfig,
  createOutboundWorker,
} from "../outbound-worker.js";
import {
  FederationRuntimeAdapter,
  NoopFederationRuntimeAdapter,
} from "../../core-domain/contracts/SigningContracts.js";
import type {
  InboundEnvelope,
  OutboundJob,
} from "../../queue/sidecar-redis-queue.js";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeInboundEnvelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    envelopeId: "env-001",
    method: "POST",
    path: "/users/alice/inbox",
    headers: {
      host: "example.com",
      date: "Mon, 04 Apr 2026 12:00:00 GMT",
      // No Signature header — triggers fast DLQ path in real worker,
      // but we'll pre-stub the queue to return nothing so start() exits
      // immediately, allowing us to call the internal path via a controlled stub.
    },
    body: JSON.stringify({
      type: "Create",
      actor: "https://remote.com/users/bob",
      id: "https://remote.com/activities/1",
      object: { type: "Note", content: "Hello" },
    }),
    remoteIp: "127.0.0.1",
    receivedAt: Date.now(),
    attempt: 0,
    notBeforeMs: 0,
    ...overrides,
  };
}

function makeOutboundJob(overrides: Partial<OutboundJob> = {}): OutboundJob {
  return {
    jobId: "job-001",
    activityId: "https://example.com/activities/1",
    actorUri: "https://example.com/users/alice",
    activity: JSON.stringify({ type: "Create" }),
    targetInbox: "https://remote.com/inbox",
    targetDomain: "remote.com",
    attempt: 0,
    maxAttempts: 8,
    notBeforeMs: 0,
    ...overrides,
  };
}

/** Builds a minimal queue stub that yields exactly one item then stops. */
function makeQueueWithInbound(envelope: InboundEnvelope) {
  return {
    consumeInbound: async function* () {
      yield { messageId: "msg-001", envelope };
    },
    consumeOutbound: async function* () {},
    enqueueInbound: vi.fn().mockResolvedValue(undefined),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    checkIdempotency: vi.fn().mockResolvedValue(true),
    clearIdempotency: vi.fn().mockResolvedValue(undefined),
    isDomainBlocked: vi.fn().mockResolvedValue(false),
    checkDomainRateLimit: vi.fn().mockResolvedValue(true),
    acquireDomainSlot: vi.fn().mockResolvedValue(true),
    releaseDomainSlot: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeQueueWithOutbound(job: OutboundJob) {
  return {
    consumeInbound: async function* () {},
    consumeOutbound: async function* () {
      yield { messageId: "msg-002", job };
    },
    enqueueInbound: vi.fn().mockResolvedValue(undefined),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    checkIdempotency: vi.fn().mockResolvedValue(true),
    clearIdempotency: vi.fn().mockResolvedValue(undefined),
    isDomainBlocked: vi.fn().mockResolvedValue(false),
    checkDomainRateLimit: vi.fn().mockResolvedValue(true),
    acquireDomainSlot: vi.fn().mockResolvedValue(true),
    releaseDomainSlot: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeRedpanda() {
  return {
    publishToStream1: vi.fn().mockResolvedValue(undefined),
    publishToStream2: vi.fn().mockResolvedValue(undefined),
  } as any;
}

/** Stub HTTP signing client that returns a successful signed response. */
function makeSigningClient() {
  return {
    signOne: vi.fn().mockResolvedValue({
      ok: true,
      requestId: "req-1",
      signedHeaders: {
        date: "Mon, 04 Apr 2026 12:00:00 GMT",
        signature: "keyId=\"test\",signature=\"abc\"",
      },
      meta: { keyId: "test", algorithm: "rsa-sha256", signedHeadersList: [] },
    }),
    signBatch: vi.fn().mockResolvedValue([]),
  } as any;
}

/** Stub HTTP delivery — returns 202 Accepted. */
function mockSuccessfulDelivery() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202 }));
}

// ---------------------------------------------------------------------------
// Inbound Worker — flag OFF
// ---------------------------------------------------------------------------

describe("InboundWorker: flag OFF → adapter hooks never called", () => {
  it("processes inbound envelope without calling onInboundVerified", async () => {
    const hookCalled = vi.fn();
    const adapter: FederationRuntimeAdapter = {
      name: "spy",
      enabled: true, // enabled=true on the adapter itself
      onInboundVerified: hookCalled,
    };

    // flag OFF — adapter will be overridden to Noop internally
    const envelope = makeInboundEnvelope();
    const queue = makeQueueWithInbound(envelope);
    const redpanda = makeRedpanda();

    const worker = new InboundWorker(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false, // FLAG OFF
      adapter,
    });

    await worker.start();
    expect(hookCalled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Inbound Worker — flag ON, successful verify
// ---------------------------------------------------------------------------

describe("InboundWorker: flag ON → onInboundVerified called with correct payload", () => {
  it("calls onInboundVerified after successful signature verification", async () => {
    const hookCalled = vi.fn().mockResolvedValue(undefined);
    const adapter: FederationRuntimeAdapter = {
      name: "spy",
      enabled: true,
      onInboundVerified: hookCalled,
    };

    // Build an envelope with a real-looking signature so we can stub
    // verifySignature by overriding the fetch for actor document.
    // Simpler: we pass a valid envelope+stub at queue level and let the
    // worker fall through to DLQ on missing sig — so we use a crafted
    // envelope that reaches verifySignature with a stubbed positive result.
    //
    // Because InboundWorker.verifySignature and forwardToActivityPods make real
    // network calls, we subclass to override both protected methods.
    class InboundWorkerStubbed extends InboundWorker {
      protected override async verifySignature(_envelope: InboundEnvelope) {
        return { valid: true, actorUri: "https://remote.com/users/bob" };
      }
      protected override async forwardToActivityPods(
        _envelope: InboundEnvelope,
        _activity: any,
        _actorUri: string
      ) {
        return { success: true };
      }
      // Expose processEnvelope directly so the test can await the full pipeline
      // instead of going through the fire-and-forget concurrency pump in start().
      async runEnvelope(msgId: string, env: InboundEnvelope) {
        return this.processEnvelope(msgId, env);
      }
    }

    const envelope = makeInboundEnvelope();
    const queue = makeQueueWithInbound(envelope);
    const redpanda = makeRedpanda();

    const worker = new InboundWorkerStubbed(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: true, // FLAG ON
      adapter,
    });

    // Call processEnvelope directly (fully awaited) to avoid the non-awaited
    // concurrency pump in start() returning before the hook fires at Step 8.
    await worker.runEnvelope("msg-001", envelope);

    // hook should have been called exactly once with the correct shape
    expect(hookCalled).toHaveBeenCalledTimes(1);
    const callArg = hookCalled.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    if (!callArg) {
      throw new Error("Expected onInboundVerified to receive an argument");
    }
    expect(callArg).toMatchObject({
      actorUri: "https://remote.com/users/bob",
      activityType: "Create",
    });
  });

  it("trusts Fedify-verified envelopes without re-running signature verification", async () => {
    const hookCalled = vi.fn().mockResolvedValue(undefined);
    const adapter: FederationRuntimeAdapter = {
      name: "spy",
      enabled: true,
      onInboundVerified: hookCalled,
    };

    const verifySignatureSpy = vi.fn();
    const forwardSpy = vi.fn().mockResolvedValue({ success: true });

    class TrustedInboundWorkerStubbed extends InboundWorker {
      protected override async verifySignature(_envelope: InboundEnvelope) {
        verifySignatureSpy();
        return { valid: false, error: "verifySignature should not run for trusted envelopes" };
      }
      protected override async forwardToActivityPods(
        _envelope: InboundEnvelope,
        _activity: any,
        actorUri: string
      ) {
        return forwardSpy(actorUri);
      }
      async runEnvelope(msgId: string, env: InboundEnvelope) {
        return this.processEnvelope(msgId, env);
      }
    }

    const envelope = makeInboundEnvelope({
      verification: {
        source: "fedify-v2",
        actorUri: "https://remote.com/users/bob",
        verifiedAt: Date.now(),
      },
    });
    const queue = makeQueueWithInbound(envelope);
    const redpanda = makeRedpanda();

    const worker = new TrustedInboundWorkerStubbed(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: true,
      adapter,
    });

    await worker.runEnvelope("msg-001", envelope);

    expect(verifySignatureSpy).not.toHaveBeenCalled();
    expect(forwardSpy).toHaveBeenCalledWith("https://remote.com/users/bob");
    expect(hookCalled).toHaveBeenCalledTimes(1);
    expect(queue.moveToDlq).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Inbound Worker — flag ON, adapter throws
// ---------------------------------------------------------------------------

describe("InboundWorker: flag ON, adapter throws → error swallowed", () => {
  it("does not propagate an adapter error to the job processing path", async () => {
    const throwingAdapter: FederationRuntimeAdapter = {
      name: "thrower",
      enabled: true,
      onInboundVerified: async () => {
        throw new Error("adapter exploded");
      },
    };

    class InboundWorkerStubbed extends InboundWorker {
      protected override async verifySignature(_envelope: InboundEnvelope) {
        return { valid: true, actorUri: "https://remote.com/users/bob" };
      }
      protected override async forwardToActivityPods(
        _envelope: InboundEnvelope,
        _activity: any,
        _actorUri: string
      ) {
        return { success: true };
      }
    }

    const envelope = makeInboundEnvelope();
    const queue = makeQueueWithInbound(envelope);
    const redpanda = makeRedpanda();

    const worker = new InboundWorkerStubbed(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: true,
      adapter: throwingAdapter,
    });

    // Should not throw
    await expect(worker.start()).resolves.not.toThrow();
    // The message should still have been ack'd
    expect(queue.ack).toHaveBeenCalledWith("inbound", "msg-001");
  });
});

describe("InboundWorker: actor consistency safety checks", () => {
  it("rejects raw verified deliveries when the verified actor does not match activity.actor", async () => {
    const forwardSpy = vi.fn();

    class InboundWorkerStubbed extends InboundWorker {
      protected override async verifySignature(_envelope: InboundEnvelope) {
        return { valid: true, actorUri: "https://remote.com/users/bob" };
      }
      protected override async forwardToActivityPods(
        _envelope: InboundEnvelope,
        _activity: any,
        _actorUri: string
      ) {
        forwardSpy();
        return { success: true };
      }
      async runEnvelope(msgId: string, env: InboundEnvelope) {
        return this.processEnvelope(msgId, env);
      }
    }

    const envelope = makeInboundEnvelope({
      body: JSON.stringify({
        type: "Create",
        actor: "https://remote.com/users/eve",
        id: "https://remote.com/activities/1",
        object: { type: "Note", content: "Hello" },
      }),
    });
    const queue = makeQueueWithInbound(envelope);
    const redpanda = makeRedpanda();

    const worker = new InboundWorkerStubbed(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: true,
    });

    await worker.runEnvelope("msg-001", envelope);

    expect(forwardSpy).not.toHaveBeenCalled();
    expect(queue.ack).toHaveBeenCalledWith("inbound", "msg-001");
    expect(queue.moveToDlq).toHaveBeenCalledTimes(1);
    expect(queue.moveToDlq).toHaveBeenCalledWith(
      "inbound",
      envelope,
      expect.stringContaining("Verified actor mismatch"),
    );
  });
});

// ---------------------------------------------------------------------------
// Outbound Worker — flag OFF
// ---------------------------------------------------------------------------

describe("OutboundWorker: flag OFF → adapter hooks never called", () => {
  it("delivers job without calling onOutboundDelivered", async () => {
    const hookCalled = vi.fn();
    const adapter: FederationRuntimeAdapter = {
      name: "spy",
      enabled: true,
      onOutboundDelivered: hookCalled,
    };

    const job = makeOutboundJob();
    const queue = makeQueueWithOutbound(job);
    const signingClient = makeSigningClient();
    const redpanda = makeRedpanda();

    class OutboundWorkerStubbed extends OutboundWorker {
      protected override async deliver(_job: OutboundJob): Promise<import("../outbound-worker.js").DeliveryResult> {
        return { jobId: _job.jobId, success: true, statusCode: 202 };
      }
    }

    const worker = new OutboundWorkerStubbed(queue, signingClient, redpanda, {
      concurrency: 1,
      maxConcurrentPerDomain: 10,
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false, // FLAG OFF
      adapter,
    });

    await worker.start();
    expect(hookCalled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound Worker — flag ON, successful delivery
// ---------------------------------------------------------------------------

describe("OutboundWorker: flag ON → onOutboundDelivered called with correct payload", () => {
  it("calls onOutboundDelivered after successful HTTP delivery", async () => {
    const hookCalled = vi.fn().mockResolvedValue(undefined);
    const adapter: FederationRuntimeAdapter = {
      name: "spy",
      enabled: true,
      onOutboundDelivered: hookCalled,
    };

    const job = makeOutboundJob();
    const queue = makeQueueWithOutbound(job);
    const signingClient = makeSigningClient();
    const redpanda = makeRedpanda();

    class OutboundWorkerStubbed extends OutboundWorker {
      protected override async deliver(_job: OutboundJob): Promise<import("../outbound-worker.js").DeliveryResult> {
        return { jobId: _job.jobId, success: true, statusCode: 202 };
      }
      // Expose processJob directly so the test can await the full pipeline.
      async runJob(msgId: string, j: OutboundJob) {
        return this.processJob(msgId, j);
      }
    }

    const worker = new OutboundWorkerStubbed(queue, signingClient, redpanda, {
      concurrency: 1,
      maxConcurrentPerDomain: 10,
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: true, // FLAG ON
      adapter,
    });

    // Call processJob directly (fully awaited) to avoid the non-awaited
    // concurrency pump in start() returning before the hook fires.
    await worker.runJob("msg-002", job);

    expect(hookCalled).toHaveBeenCalledTimes(1);
    const callArg = hookCalled.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    if (!callArg) {
      throw new Error("Expected onOutboundDelivered to receive an argument");
    }
    expect(callArg).toMatchObject({
      actorUri: job.actorUri,
      activityId: job.activityId,
      targetDomain: job.targetDomain,
    });
    expect(typeof callArg.statusCode).toBe("number");
  });

  it("delegates outbound delivery to adapter.deliverOutbound when available", async () => {
    const deliverOutbound = vi.fn().mockResolvedValue({
      jobId: "job-001",
      success: true,
      statusCode: 202,
    });
    const adapter: FederationRuntimeAdapter = {
      name: "spy",
      enabled: true,
      deliverOutbound,
    };

    class OutboundWorkerDelegating extends OutboundWorker {
      async runDeliver(job: OutboundJob) {
        return this.deliver(job);
      }
    }

    const job = makeOutboundJob();
    const signingClient = makeSigningClient();
    const worker = new OutboundWorkerDelegating(
      makeQueueWithOutbound(job),
      signingClient,
      makeRedpanda(),
      {
        concurrency: 1,
        maxConcurrentPerDomain: 10,
        requestTimeoutMs: 5000,
        userAgent: "test",
        fedifyRuntimeIntegrationEnabled: true,
        adapter,
      },
    );

    await expect(worker.runDeliver(job)).resolves.toMatchObject({
      success: true,
      statusCode: 202,
    });
    expect(deliverOutbound).toHaveBeenCalledTimes(1);
    expect(signingClient.signOne).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound Worker — flag ON, adapter throws
// ---------------------------------------------------------------------------

describe("OutboundWorker: flag ON, adapter throws → error swallowed", () => {
  it("does not propagate an adapter error to the job processing path", async () => {
    const throwingAdapter: FederationRuntimeAdapter = {
      name: "thrower",
      enabled: true,
      onOutboundDelivered: async () => {
        throw new Error("adapter exploded");
      },
    };

    const job = makeOutboundJob();
    const queue = makeQueueWithOutbound(job);
    const signingClient = makeSigningClient();
    const redpanda = makeRedpanda();

    class OutboundWorkerStubbed extends OutboundWorker {
      protected override async deliver(_job: OutboundJob): Promise<import("../outbound-worker.js").DeliveryResult> {
        return { jobId: _job.jobId, success: true, statusCode: 202 };
      }
    }

    const worker = new OutboundWorkerStubbed(queue, signingClient, redpanda, {
      concurrency: 1,
      maxConcurrentPerDomain: 10,
      requestTimeoutMs: 5000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: true,
      adapter: throwingAdapter,
    });

    await expect(worker.start()).resolves.not.toThrow();
    expect(queue.ack).toHaveBeenCalledWith("outbound", "msg-002");
  });
});

describe("OutboundWorker: permanent failure hook", () => {
  it("calls onOutboundPermanentFailure when a permanent delivery failure occurs", async () => {
    const permanentFailureHook = vi.fn().mockResolvedValue(undefined);
    const adapter: FederationRuntimeAdapter = {
      name: "spy",
      enabled: true,
      onOutboundPermanentFailure: permanentFailureHook,
    };

    class OutboundWorkerStubbed extends OutboundWorker {
      protected override async deliver(_job: OutboundJob): Promise<import("../outbound-worker.js").DeliveryResult> {
        return {
          jobId: _job.jobId,
          success: false,
          permanent: true,
          statusCode: 410,
          error: "Gone",
          responseBody: "gone",
        };
      }
      async runJob(msgId: string, j: OutboundJob) {
        return this.processJob(msgId, j);
      }
    }

    const job = makeOutboundJob();
    const worker = new OutboundWorkerStubbed(
      makeQueueWithOutbound(job),
      makeSigningClient(),
      makeRedpanda(),
      {
        concurrency: 1,
        maxConcurrentPerDomain: 10,
        requestTimeoutMs: 5000,
        userAgent: "test",
        fedifyRuntimeIntegrationEnabled: true,
        adapter,
      },
    );

    await worker.runJob("msg-002", job);

    expect(permanentFailureHook).toHaveBeenCalledTimes(1);
    expect(permanentFailureHook.mock.calls[0]?.[0]).toMatchObject({
      actorUri: job.actorUri,
      activityId: job.activityId,
      targetDomain: job.targetDomain,
      targetInbox: job.targetInbox,
      statusCode: 410,
      error: "Gone",
      responseBody: "gone",
      attempt: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// NoopFederationRuntimeAdapter contract
// ---------------------------------------------------------------------------

describe("NoopFederationRuntimeAdapter contract", () => {
  it("has enabled=false so callAdapter short-circuits without invoking any hook", () => {
    expect(NoopFederationRuntimeAdapter.enabled).toBe(false);
    expect(NoopFederationRuntimeAdapter.name).toBe("noop");
    expect(NoopFederationRuntimeAdapter.deliverOutbound).toBeUndefined();
    expect(NoopFederationRuntimeAdapter.onInboundVerified).toBeUndefined();
    expect(NoopFederationRuntimeAdapter.onOutboundDelivered).toBeUndefined();
    expect(NoopFederationRuntimeAdapter.onOutboundPermanentFailure).toBeUndefined();
  });
});
