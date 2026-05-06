vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { InboundWorker } from "../inbound-worker.js";
import { InMemoryMRFAdminStore } from "../../admin/mrf/store.memory.js";
import { ensureDefaultModuleConfigs } from "../../admin/mrf/bootstrap.js";
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

function makeEnvelope(actorUri: string): InboundEnvelope {
  return {
    envelopeId: "env-1",
    method: "POST",
    path: "/users/alice/inbox",
    headers: {
      host: "local.example",
      date: new Date().toUTCString(),
    },
    body: JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/1",
      type: "Create",
      actor: actorUri,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: "https://remote.example/objects/1",
        type: "Note",
        content: "hello",
      },
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

function makeAnnounceEnvelope(params: {
  actorUri: string;
  attributedTo: string;
  announceTo?: string[];
  objectTo?: string[];
}): InboundEnvelope {
  const announceTo = params.announceTo ?? ["https://www.w3.org/ns/activitystreams#Public"];
  const objectTo = params.objectTo ?? ["https://remote.example/users/author/followers"];
  return {
    envelopeId: "env-announce-1",
    method: "POST",
    path: "/users/alice/inbox",
    headers: {
      host: "local.example",
      date: new Date().toUTCString(),
    },
    body: JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/announce-1",
      type: "Announce",
      actor: params.actorUri,
      to: announceTo,
      object: {
        id: "https://remote.example/objects/note-1",
        type: "Note",
        attributedTo: params.attributedTo,
        to: objectTo,
        content: "followers-only note",
      },
    }),
    remoteIp: "127.0.0.1",
    receivedAt: Date.now(),
    attempt: 0,
    notBeforeMs: 0,
    verification: {
      source: "fedify-v2",
      actorUri: params.actorUri,
      verifiedAt: Date.now(),
    },
  };
}

describe("InboundWorker subject policy enforcement", () => {
  it("drops a rejected actor before forwarding or stream writes", async () => {
    const now = () => "2026-04-21T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("activitypub-subject-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("activitypub-subject-policy config missing");
    await store.setModuleConfig("activitypub-subject-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        rules: [
          {
            id: "rule-1",
            action: "reject",
            actorUri: "https://remote.example/users/alice",
          },
        ],
      },
    });

    const queue = makeQueue();
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
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false,
      activityPodsBridge: bridge,
      getMrfAdminStore: () => store,
      resolveWebIdForActorUri: vi.fn().mockResolvedValue(null),
    });

    await worker.runEnvelope("msg-1", makeEnvelope("https://remote.example/users/alice"));

    expect(queue.ack).toHaveBeenCalled();
    expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    expect(redpanda.publishToStream1).not.toHaveBeenCalled();
    expect(redpanda.publishToStream2).not.toHaveBeenCalled();
  });

  it("limits a filtered actor without dropping the Pod commit path", async () => {
    const now = () => "2026-04-21T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("activitypub-subject-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("activitypub-subject-policy config missing");
    await store.setModuleConfig("activitypub-subject-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        rules: [
          {
            id: "rule-filter-1",
            action: "filter",
            domain: "remote.example",
          },
        ],
      },
    });

    const queue = makeQueue();
    const redpanda = {
      publishToStream1: vi.fn().mockResolvedValue(undefined),
      publishToStream2: vi.fn().mockResolvedValue(undefined),
      publishTombstone: vi.fn().mockResolvedValue(undefined),
    } as any;
    const bridge = {
      forwardInboundActivity: vi.fn().mockResolvedValue({ status: 200 }),
    };
    const atProjection = {
      projectToCanonical: vi.fn().mockResolvedValue(undefined),
    };
    const canonicalPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new TestInboundWorker(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false,
      activityPodsBridge: bridge,
      atProjection,
      canonicalPublisher,
      getMrfAdminStore: () => store,
      resolveWebIdForActorUri: vi.fn().mockResolvedValue(null),
    });

    await worker.runEnvelope("msg-1", makeEnvelope("https://remote.example/users/alice"));

    expect(queue.ack).toHaveBeenCalled();
    expect(bridge.forwardInboundActivity).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream1).not.toHaveBeenCalled();
    expect(redpanda.publishToStream2).not.toHaveBeenCalled();
    expect(atProjection.projectToCanonical).not.toHaveBeenCalled();
    expect(canonicalPublisher.publish).not.toHaveBeenCalled();
  });

  it("limits spam-filtered activity without discarding it like a reject", async () => {
    const queue = makeQueue();
    const redpanda = {
      publishToStream1: vi.fn().mockResolvedValue(undefined),
      publishToStream2: vi.fn().mockResolvedValue(undefined),
      publishTombstone: vi.fn().mockResolvedValue(undefined),
    } as any;
    const bridge = {
      forwardInboundActivity: vi.fn().mockResolvedValue({ status: 200 }),
    };
    const spamEvaluator = {
      evaluateAp: vi.fn().mockResolvedValue({
        moduleId: "domain-reputation",
        traceId: "trace-spam-filter",
        appliedAction: "filter",
      }),
    };
    const worker = new TestInboundWorker(queue, redpanda, {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false,
      activityPodsBridge: bridge,
      spamEvaluator: spamEvaluator as any,
    });

    await worker.runEnvelope("msg-1", makeEnvelope("https://remote.example/users/alice"));

    expect(spamEvaluator.evaluateAp).toHaveBeenCalled();
    expect(queue.ack).toHaveBeenCalled();
    expect(bridge.forwardInboundActivity).toHaveBeenCalledTimes(1);
    expect(redpanda.publishToStream2).not.toHaveBeenCalled();
  });

  it("drops remote Akkoma local-scope-only Create before forwarding", async () => {
    const queue = makeQueue();
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
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false,
      activityPodsBridge: bridge,
    });

    const envelope = makeEnvelope("https://remote.example/users/alice");
    const body = JSON.parse(envelope.body);
    body.to = ["https://remote.example/#Public"];
    body.cc = [];
    envelope.body = JSON.stringify(body);

    await worker.runEnvelope("msg-local-scope", envelope);

    expect(queue.ack).toHaveBeenCalled();
    expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    expect(redpanda.publishToStream2).not.toHaveBeenCalled();
  });

  it("drops Announce of followers-only inline object by non-author", async () => {
    const queue = makeQueue();
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
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false,
      activityPodsBridge: bridge,
    });

    await worker.runEnvelope(
      "msg-announce-followers-reject",
      makeAnnounceEnvelope({
        actorUri: "https://remote.example/users/booster",
        attributedTo: "https://remote.example/users/original-author",
      }),
    );

    expect(queue.ack).toHaveBeenCalled();
    expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    expect(redpanda.publishToStream2).not.toHaveBeenCalled();
  });

  it("allows Announce of followers-only inline object by original author", async () => {
    const queue = makeQueue();
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
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false,
      activityPodsBridge: bridge,
    });

    await worker.runEnvelope(
      "msg-announce-followers-author-ok",
      makeAnnounceEnvelope({
        actorUri: "https://remote.example/users/original-author",
        attributedTo: "https://remote.example/users/original-author",
      }),
    );

    expect(queue.ack).toHaveBeenCalled();
    expect(bridge.forwardInboundActivity).toHaveBeenCalledTimes(1);
  });
});
