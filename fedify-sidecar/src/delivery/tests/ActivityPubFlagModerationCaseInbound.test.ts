vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { InboundWorker } from "../inbound-worker.js";
import { InMemoryModerationBridgeStore } from "../../admin/moderation/store.memory.js";
import type { InboundEnvelope } from "../../queue/sidecar-redis-queue.js";

class TestInboundWorker extends InboundWorker {
  async runEnvelope(messageId: string, envelope: InboundEnvelope) {
    return this.processEnvelope(messageId, envelope);
  }
}

function makeQueue() {
  return {
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    enqueueInbound: vi.fn().mockResolvedValue(undefined),
    isDomainBlocked: vi.fn().mockResolvedValue(false),
    getCachedActorDoc: vi.fn().mockResolvedValue(null),
    cacheActorDoc: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeFlagEnvelope(): InboundEnvelope {
  const actorUri = "https://remote.example/users/reporter";
  return {
    envelopeId: "flag-env-1",
    method: "POST",
    path: "/users/alice/inbox",
    headers: {
      host: "local.example",
      date: new Date().toUTCString(),
    },
    body: JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/flags/1",
      type: "Flag",
      actor: actorUri,
      object: [
        "https://remote.example/users/spammer",
        {
          id: "https://remote.example/activities/10",
          type: "Create",
          actor: "https://remote.example/users/spammer",
          object: {
            id: "https://remote.example/notes/10",
            type: "Note",
            attributedTo: "https://remote.example/users/spammer",
          },
        },
      ],
      content: "spam, harassment",
      published: "2026-04-21T11:58:00.000Z",
    }),
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

describe("InboundWorker ActivityPub Flag moderation cases", () => {
  it("captures a verified Flag as an inbound moderation case and skips forwarding", async () => {
    const queue = makeQueue();
    const store = new InMemoryModerationBridgeStore();
    const canonicalPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const redpanda = {
      publishToStream1: vi.fn().mockResolvedValue(undefined),
      publishToStream2: vi.fn().mockResolvedValue(undefined),
      publishTombstone: vi.fn().mockResolvedValue(undefined),
    } as any;
    const bridge = {
      forwardInboundActivity: vi.fn().mockResolvedValue({ status: 200 }),
    };
    const worker = new TestInboundWorker(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "https://local.example",
      activityPodsToken: "token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      domain: "local.example",
      fedifyRuntimeIntegrationEnabled: false,
      activityPodsBridge: bridge,
      canonicalPublisher,
      getModerationBridgeStore: () => store,
      resolveWebIdForActorUri: vi.fn().mockImplementation(async (actorUri: string) =>
        actorUri === "https://local.example/users/alice" ? "https://local.example/alice#me" : null,
      ),
    });

    const envelope = makeFlagEnvelope();
    await worker.runEnvelope("msg-flag-1", envelope);
    await worker.runEnvelope("msg-flag-2", envelope);

    const page = await store.listCases({ limit: 10 });
    expect(page.cases).toHaveLength(1);
    expect(page.cases[0]).toEqual(
      expect.objectContaining({
        source: "activitypub-flag",
        protocol: "ap",
        reason: "spam, harassment",
        status: "open",
        reporter: expect.objectContaining({
          activityPubActorUri: "https://remote.example/users/reporter",
        }),
        recipient: expect.objectContaining({
          webId: "https://local.example/alice#me",
        }),
        subject: {
          kind: "account",
          actor: expect.objectContaining({
            activityPubActorUri: "https://remote.example/users/spammer",
          }),
          authoritativeProtocol: "ap",
        },
        evidenceObjectRefs: expect.arrayContaining([
          expect.objectContaining({
            activityPubObjectId: "https://remote.example/activities/10",
          }),
        ]),
        canonicalEvent: expect.objectContaining({
          status: "published",
        }),
      }),
    );
    expect(queue.ack).toHaveBeenCalledTimes(2);
    expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    expect(canonicalPublisher.publish).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream1).not.toHaveBeenCalled();
    expect(redpanda.publishToStream2).not.toHaveBeenCalled();
  });
});
