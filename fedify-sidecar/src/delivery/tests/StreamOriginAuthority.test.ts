vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { InboundWorker } from "../inbound-worker.js";
import type { InboundEnvelope } from "../../queue/sidecar-redis-queue.js";

class StreamOriginTestWorker extends InboundWorker {
  async runEnvelope(messageId: string, envelope: InboundEnvelope): Promise<void> {
    return this.processEnvelope(messageId, envelope);
  }
}

function makeQueue() {
  return {
    consumeInbound: async function* () {},
    enqueueInbound: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    isDomainBlocked: vi.fn().mockResolvedValue(false),
    getCachedActorDoc: vi.fn().mockResolvedValue(null),
    cacheActorDoc: vi.fn().mockResolvedValue(undefined),
    getClaimIdleTimeMs: () => 60_000,
  } as any;
}

function makeRedpanda() {
  return {
    publishToStream1: vi.fn().mockResolvedValue(undefined),
    publishToStream2: vi.fn().mockResolvedValue(undefined),
    publishTombstone: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makePublicCreate(actorUri: string) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actorUri}/activities/1`,
    type: "Create",
    actor: actorUri,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    object: {
      id: `${actorUri}/objects/1`,
      type: "Note",
      content: "stream authority regression",
    },
  };
}

function makeEnvelope(activity: Record<string, unknown>, actorUri: string): InboundEnvelope {
  return {
    envelopeId: "stream-origin-authority-1",
    method: "POST",
    path: "/users/alice/inbox",
    headers: {
      host: "local.example",
      date: new Date().toUTCString(),
    },
    body: JSON.stringify(activity),
    remoteIp: "127.0.0.1",
    receivedAt: Date.now(),
    attempt: 0,
    notBeforeMs: 0,
    verification: {
      source: "fedify-v2",
      actorUri,
      verifiedAt: Date.now(),
    },
  };
}

describe("ActivityPub RedPanda stream origin authority", () => {
  it("routes a verified remote actor whose path contains the local-domain text to Stream2", async () => {
    const actorUri = "https://remote.example/https://local.example/users/eve";
    const activity = makePublicCreate(actorUri);
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const activityPodsBridge = {
      forwardInboundActivity: vi.fn().mockResolvedValue({ status: 200 }),
    };
    const canonicalPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new StreamOriginTestWorker(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "test-token",
      requestTimeoutMs: 5_000,
      userAgent: "stream-origin-authority-test",
      fedifyRuntimeIntegrationEnabled: false,
      domain: "local.example",
      activityPodsBridge,
      canonicalPublisher,
    });

    await worker.runEnvelope("message-1", makeEnvelope(activity, actorUri));

    expect(redpanda.publishToStream1).not.toHaveBeenCalled();
    expect(redpanda.publishToStream2).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream2).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUri,
        origin: undefined,
        activity: expect.objectContaining({ id: activity.id }),
      }),
    );
    expect(activityPodsBridge.forwardInboundActivity).toHaveBeenCalledTimes(1);
    expect(canonicalPublisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUri,
        isLocal: false,
        isPublic: true,
      }),
    );
    expect(queue.moveToDlq).not.toHaveBeenCalled();
  });

  it("continues routing an exact local actor hostname to Stream1", async () => {
    const actorUri = "https://local.example/users/alice";
    const activity = makePublicCreate(actorUri);
    const queue = makeQueue();
    const redpanda = makeRedpanda();
    const activityPodsBridge = {
      forwardInboundActivity: vi.fn().mockResolvedValue({ status: 200 }),
    };
    const canonicalPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new StreamOriginTestWorker(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "test-token",
      requestTimeoutMs: 5_000,
      userAgent: "stream-origin-authority-test",
      fedifyRuntimeIntegrationEnabled: false,
      domain: "LOCAL.EXAMPLE",
      activityPodsBridge,
      canonicalPublisher,
    });

    await worker.runEnvelope("message-2", makeEnvelope(activity, actorUri));

    expect(redpanda.publishToStream1).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream2).not.toHaveBeenCalled();
    expect(activityPodsBridge.forwardInboundActivity).not.toHaveBeenCalled();
    expect(canonicalPublisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({ actorUri, isLocal: true, isPublic: true }),
    );
  });
});
