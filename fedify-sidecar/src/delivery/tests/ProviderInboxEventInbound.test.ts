/**
 * Provider inbox event routing (Step 3.76) tests.
 *
 * Verifies that non-Flag provider-directed activities are routed to the
 * ActivityPodsProviderInboxEventClient (Step 3.76) rather than the normal
 * ActivityPods forwarding path, and that:
 *
 *  - ACK is withheld when the client returns false (transient failure)
 *  - ACK is sent when the client returns true (success or permanent 4xx)
 *  - Flag activities bypass Step 3.76 (they are handled by Step 3.75)
 *  - Classification works by direct inbox path AND by shared-inbox recipient URIs
 *  - Undo{Flag} and Accept/Reject are routed correctly
 *  - Step 3.76 runs BEFORE the Redis idempotency guard
 */

vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InboundWorker } from "../inbound-worker.js";
import type { InboundEnvelope } from "../../queue/sidecar-redis-queue.js";
import type { ActivityPodsProviderInboxEventClient } from "../../admin/moderation/ActivityPodsProviderInboxEventClient.js";

// ── Constants matching the sidecar config ─────────────────────────────────────

const DOMAIN = "local.example";
const PROVIDER_ACTOR_URI = `https://${DOMAIN}/users/provider`;
const ACTOR_ALIAS_URI = `https://${DOMAIN}/actor`;
const LEGACY_PROVIDER_URI = `https://${DOMAIN}/users/moderation`;

const PROVIDER_ACTOR_URIS = new Set([
  PROVIDER_ACTOR_URI,
  ACTOR_ALIAS_URI,
  LEGACY_PROVIDER_URI,
]);

const PROVIDER_ACTOR_INBOX_PATHS = new Set([
  "/users/provider/inbox",
  "/actor/inbox",
  "/users/moderation/inbox",
]);

// ── Subclass exposing processEnvelope ─────────────────────────────────────────

class TestWorker extends InboundWorker {
  async runEnvelope(msgId: string, env: InboundEnvelope) {
    return this.processEnvelope(msgId, env);
  }
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeQueue(opts: { blockedDomains?: Set<string> } = {}) {
  return {
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    enqueueInbound: vi.fn().mockResolvedValue(undefined),
    isDomainBlocked: vi.fn().mockImplementation(async (d: string) =>
      opts.blockedDomains?.has(d) ?? false,
    ),
    getCachedActorDoc: vi.fn().mockResolvedValue(null),
    cacheActorDoc: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeRedpanda() {
  return {
    publishToStream1: vi.fn().mockResolvedValue(undefined),
    publishToStream2: vi.fn().mockResolvedValue(undefined),
    publishTombstone: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeIdempotencyGuard(isNew = true) {
  return {
    claimIfNew: vi.fn().mockResolvedValue(isNew),
  };
}

/** Build a mock providerInboxEventClient with controllable return value. */
function makeProviderClient(returns: boolean = true): ActivityPodsProviderInboxEventClient & {
  sendUndoFlag: ReturnType<typeof vi.fn>;
  sendAcceptReject: ReturnType<typeof vi.fn>;
  sendGenericEvent: ReturnType<typeof vi.fn>;
} {
  return {
    sendUndoFlag: vi.fn().mockResolvedValue(returns),
    sendAcceptReject: vi.fn().mockResolvedValue(returns),
    sendGenericEvent: vi.fn().mockResolvedValue(returns),
  } as any;
}

/** Build a pre-trusted inbound envelope. */
function makeEnvelope(
  activity: Record<string, unknown>,
  path: string,
): InboundEnvelope {
  const actorUri =
    typeof activity["actor"] === "string"
      ? activity["actor"]
      : "https://remote.example/users/sender";
  return {
    envelopeId: `test-${Math.random().toString(36).slice(2)}`,
    method: "POST",
    path,
    headers: { host: DOMAIN, date: new Date().toUTCString() },
    body: JSON.stringify(activity),
    remoteIp: "1.2.3.4",
    receivedAt: Date.now(),
    attempt: 0,
    notBeforeMs: 0,
    verification: { source: "fedify-v2", actorUri, verifiedAt: Date.now() },
  };
}

/** Build a worker with provider inbox routing configured. */
function makeWorker(opts: {
  providerClient?: ActivityPodsProviderInboxEventClient;
  idempotencyGuard?: { claimIfNew: (id: string) => Promise<boolean> };
  bridge?: { forwardInboundActivity: (...a: any[]) => Promise<any> };
} = {}) {
  const queue = makeQueue();
  const redpanda = makeRedpanda();
  const bridge = opts.bridge ?? {
    forwardInboundActivity: vi.fn().mockResolvedValue({ status: 200 }),
  };
  const worker = new TestWorker(queue, redpanda, {
    concurrency: 1,
    activityPodsUrl: `https://${DOMAIN}`,
    activityPodsToken: "token",
    requestTimeoutMs: 5_000,
    userAgent: "test",
    domain: DOMAIN,
    fedifyRuntimeIntegrationEnabled: false,
    activityPodsBridge: bridge,
    providerActorUris: PROVIDER_ACTOR_URIS,
    providerActorInboxPaths: PROVIDER_ACTOR_INBOX_PATHS,
    ...(opts.providerClient ? { providerInboxEventClient: opts.providerClient } : {}),
    ...(opts.idempotencyGuard ? { inboundIdempotencyGuard: opts.idempotencyGuard } : {}),
  });
  return { worker, queue, redpanda, bridge };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("InboundWorker Step 3.76 — provider inbox event routing", () => {
  // ── Direct-inbox-path classification ───────────────────────────────────────

  describe("direct provider inbox path routing", () => {
    it("routes a Follow to the provider client when delivered to /users/provider/inbox", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue, bridge } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/1",
        type: "Follow",
        actor: "https://remote.example/users/bob",
        object: PROVIDER_ACTOR_URI,
      };

      await worker.runEnvelope("msg-1", makeEnvelope(activity, "/users/provider/inbox"));

      expect(providerClient.sendGenericEvent).toHaveBeenCalledOnce();
      expect(providerClient.sendGenericEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          activityType: "Follow",
          actorUri: "https://remote.example/users/bob",
          envelopePath: "/users/provider/inbox",
        }),
      );
      expect(queue.ack).toHaveBeenCalledOnce();
      expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    });

    it("routes to provider client when delivered to /actor/inbox", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue, bridge } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/accepts/1",
        type: "Accept",
        actor: "https://remote.example/users/carol",
        object: "https://remote.example/follows/99",
      };

      await worker.runEnvelope("msg-2", makeEnvelope(activity, "/actor/inbox"));

      expect(providerClient.sendAcceptReject).toHaveBeenCalledOnce();
      expect(queue.ack).toHaveBeenCalledOnce();
      expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    });

    it("routes to provider client for legacy /users/moderation/inbox path", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/2",
        type: "Follow",
        actor: "https://remote.example/users/dave",
        object: LEGACY_PROVIDER_URI,
      };

      await worker.runEnvelope("msg-3", makeEnvelope(activity, "/users/moderation/inbox"));

      expect(providerClient.sendGenericEvent).toHaveBeenCalledOnce();
      expect(queue.ack).toHaveBeenCalledOnce();
    });
  });

  // ── Shared-inbox recipient classification ──────────────────────────────────

  describe("shared-inbox recipient classification", () => {
    it("routes when provider actor URI appears in to[] on shared inbox delivery", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue, bridge } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/3",
        type: "Follow",
        actor: "https://remote.example/users/eve",
        to: [PROVIDER_ACTOR_URI],
        object: PROVIDER_ACTOR_URI,
      };

      // Delivered to shared inbox, not a provider-specific inbox path
      await worker.runEnvelope("msg-4", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendGenericEvent).toHaveBeenCalledOnce();
      expect(queue.ack).toHaveBeenCalledOnce();
      expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    });

    it("routes when provider actor URI appears in cc[] on shared inbox delivery", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue, bridge } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/likes/1",
        type: "Like",
        actor: "https://remote.example/users/frank",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [PROVIDER_ACTOR_URI],
      };

      await worker.runEnvelope("msg-5", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendGenericEvent).toHaveBeenCalledOnce();
      expect(queue.ack).toHaveBeenCalledOnce();
      expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    });

    it("routes when /actor alias URI appears in recipients", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/4",
        type: "Follow",
        actor: "https://remote.example/users/grace",
        to: [ACTOR_ALIAS_URI],
        object: ACTOR_ALIAS_URI,
      };

      await worker.runEnvelope("msg-6", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendGenericEvent).toHaveBeenCalledOnce();
      expect(queue.ack).toHaveBeenCalledOnce();
    });

    it("does NOT route non-provider activities through provider client on shared inbox", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, bridge } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/creates/1",
        type: "Create",
        actor: "https://remote.example/users/helen",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        object: { id: "https://remote.example/notes/1", type: "Note", content: "hello" },
      };

      await worker.runEnvelope("msg-7", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendGenericEvent).not.toHaveBeenCalled();
      expect(providerClient.sendAcceptReject).not.toHaveBeenCalled();
      expect(bridge.forwardInboundActivity).toHaveBeenCalled();
    });
  });

  // ── Activity-type dispatch ─────────────────────────────────────────────────

  describe("activity type dispatch", () => {
    it("calls sendUndoFlag for Undo{Flag} activities", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/undos/1",
        type: "Undo",
        actor: "https://remote.example/users/ivan",
        to: [PROVIDER_ACTOR_URI],
        object: {
          id: "https://remote.example/flags/1",
          type: "Flag",
          actor: "https://remote.example/users/ivan",
          object: ["https://remote.example/users/spammer"],
        },
      };

      await worker.runEnvelope("msg-8", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendUndoFlag).toHaveBeenCalledOnce();
      expect(providerClient.sendUndoFlag).toHaveBeenCalledWith(
        expect.objectContaining({
          originalFlagId: "https://remote.example/flags/1",
          actorUri: "https://remote.example/users/ivan",
        }),
      );
      expect(queue.ack).toHaveBeenCalledOnce();
    });

    it("calls sendAcceptReject for Accept activities", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/accepts/2",
        type: "Accept",
        actor: "https://remote.example/users/jane",
        to: [PROVIDER_ACTOR_URI],
        object: "https://remote.example/follows/5",
      };

      await worker.runEnvelope("msg-9", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendAcceptReject).toHaveBeenCalledOnce();
      expect(providerClient.sendAcceptReject).toHaveBeenCalledWith(
        expect.objectContaining({
          activityType: "Accept",
          objectId: "https://remote.example/follows/5",
        }),
      );
      expect(queue.ack).toHaveBeenCalledOnce();
    });

    it("calls sendAcceptReject for Reject activities", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/rejects/1",
        type: "Reject",
        actor: "https://remote.example/users/kate",
        to: [PROVIDER_ACTOR_URI],
        object: { id: "https://remote.example/follows/6", type: "Follow" },
      };

      await worker.runEnvelope("msg-10", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendAcceptReject).toHaveBeenCalledWith(
        expect.objectContaining({
          activityType: "Reject",
          objectId: "https://remote.example/follows/6",
        }),
      );
      expect(queue.ack).toHaveBeenCalledOnce();
    });

    it("calls sendGenericEvent for non-special activity types (Follow)", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/7",
        type: "Follow",
        actor: "https://remote.example/users/liam",
        to: [PROVIDER_ACTOR_URI],
        object: PROVIDER_ACTOR_URI,
      };

      await worker.runEnvelope("msg-11", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendGenericEvent).toHaveBeenCalledWith(
        expect.objectContaining({ activityType: "Follow" }),
      );
      expect(queue.ack).toHaveBeenCalledOnce();
    });

    it("does NOT route Flag activities through Step 3.76 (handled by Step 3.75)", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/flags/99",
        type: "Flag",
        actor: "https://remote.example/users/mia",
        to: [PROVIDER_ACTOR_URI],
        object: ["https://remote.example/users/spammer2"],
        content: "This is spam",
      };

      await worker.runEnvelope("msg-12", makeEnvelope(activity, "/users/provider/inbox"));

      // All provider client methods must NOT have been called
      expect(providerClient.sendUndoFlag).not.toHaveBeenCalled();
      expect(providerClient.sendAcceptReject).not.toHaveBeenCalled();
      expect(providerClient.sendGenericEvent).not.toHaveBeenCalled();
      // Message ACKed (Step 3.75 handles Flag and ACKs)
      expect(queue.ack).toHaveBeenCalledOnce();
    });
  });

  // ── ACK behaviour on failure ───────────────────────────────────────────────

  describe("ACK behaviour", () => {
    it("does NOT ACK when providerInboxEventClient returns false (transient failure)", async () => {
      const providerClient = makeProviderClient(false); // transient failure
      const { worker, queue, bridge } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/8",
        type: "Follow",
        actor: "https://remote.example/users/noah",
        to: [PROVIDER_ACTOR_URI],
        object: PROVIDER_ACTOR_URI,
      };

      await worker.runEnvelope("msg-13", makeEnvelope(activity, "/users/provider/inbox"));

      // Message must NOT be ACKed — XAUTOCLAIM will retry
      expect(queue.ack).not.toHaveBeenCalled();
      // Normal ActivityPods forwarding must NOT have been called
      expect(bridge.forwardInboundActivity).not.toHaveBeenCalled();
    });

    it("ACKs when providerInboxEventClient returns true (success)", async () => {
      const providerClient = makeProviderClient(true);
      const { worker, queue } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/9",
        type: "Follow",
        actor: "https://remote.example/users/olivia",
        to: [PROVIDER_ACTOR_URI],
        object: PROVIDER_ACTOR_URI,
      };

      await worker.runEnvelope("msg-14", makeEnvelope(activity, "/users/provider/inbox"));

      expect(queue.ack).toHaveBeenCalledOnce();
    });
  });

  // ── Idempotency guard ordering ─────────────────────────────────────────────

  describe("idempotency guard ordering (Step 3.76 runs before Redis guard)", () => {
    it("does not claim idempotency when client returns false", async () => {
      // If Step 3.76 ran AFTER the Redis guard, a transient failure would still
      // claim the activityId, blocking the retry.  It must NOT.
      const providerClient = makeProviderClient(false);
      const idempotencyGuard = makeIdempotencyGuard(true); // would claim if called
      const { worker, queue } = makeWorker({ providerClient, idempotencyGuard });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/10",
        type: "Follow",
        actor: "https://remote.example/users/pete",
        to: [PROVIDER_ACTOR_URI],
        object: PROVIDER_ACTOR_URI,
      };

      await worker.runEnvelope("msg-15", makeEnvelope(activity, "/users/provider/inbox"));

      // idempotency guard must NOT have been called
      expect(idempotencyGuard.claimIfNew).not.toHaveBeenCalled();
      // message must NOT be ACKed
      expect(queue.ack).not.toHaveBeenCalled();
    });

    it("does not claim idempotency for provider-directed events (idempotency guard is bypassed)", async () => {
      const providerClient = makeProviderClient(true);
      const idempotencyGuard = makeIdempotencyGuard(true);
      const { worker } = makeWorker({ providerClient, idempotencyGuard });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/11",
        type: "Follow",
        actor: "https://remote.example/users/quinn",
        to: [PROVIDER_ACTOR_URI],
        object: PROVIDER_ACTOR_URI,
      };

      await worker.runEnvelope("msg-16", makeEnvelope(activity, "/users/provider/inbox"));

      // Even on success, the Redis idempotency guard is not called for
      // provider-directed events — Step 3.76 exits early before reaching it.
      expect(idempotencyGuard.claimIfNew).not.toHaveBeenCalled();
    });
  });

  // ── No provider client configured ─────────────────────────────────────────

  describe("when no providerInboxEventClient is configured", () => {
    it("falls through to normal ActivityPods forwarding", async () => {
      const bridge = {
        forwardInboundActivity: vi.fn().mockResolvedValue({ status: 200 }),
      };
      // Worker has providerActorUris+Paths but NO client
      const queue = makeQueue();
      const worker = new TestWorker(queue, makeRedpanda(), {
        concurrency: 1,
        activityPodsUrl: `https://${DOMAIN}`,
        activityPodsToken: "token",
        requestTimeoutMs: 5_000,
        userAgent: "test",
        domain: DOMAIN,
        fedifyRuntimeIntegrationEnabled: false,
        activityPodsBridge: bridge,
        providerActorUris: PROVIDER_ACTOR_URIS,
        providerActorInboxPaths: PROVIDER_ACTOR_INBOX_PATHS,
        // no providerInboxEventClient
      });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/follows/12",
        type: "Follow",
        actor: "https://remote.example/users/rachel",
        to: [PROVIDER_ACTOR_URI],
        object: PROVIDER_ACTOR_URI,
      };

      await worker.runEnvelope(
        "msg-17",
        makeEnvelope(activity, "/users/provider/inbox"),
      );

      expect(bridge.forwardInboundActivity).toHaveBeenCalledOnce();
      expect(queue.ack).toHaveBeenCalledOnce();
    });
  });

  // ── Undo{Flag} object-id extraction ───────────────────────────────────────

  describe("Undo{Flag} object-id extraction", () => {
    it("extracts object.id from inline Flag object", async () => {
      const providerClient = makeProviderClient(true);
      const { worker } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/undos/2",
        type: "Undo",
        actor: "https://remote.example/users/sam",
        to: [PROVIDER_ACTOR_URI],
        object: {
          id: "https://remote.example/flags/2",
          type: "Flag",
          actor: "https://remote.example/users/sam",
          object: ["https://remote.example/users/spammer3"],
        },
      };

      await worker.runEnvelope("msg-18", makeEnvelope(activity, "/inbox"));

      expect(providerClient.sendUndoFlag).toHaveBeenCalledWith(
        expect.objectContaining({
          originalFlagId: "https://remote.example/flags/2",
        }),
      );
    });

    it("falls back to sendGenericEvent for Undo with URI-only object (cannot confirm Flag type)", async () => {
      const providerClient = makeProviderClient(true);
      const { worker } = makeWorker({ providerClient });

      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/undos/3",
        type: "Undo",
        actor: "https://remote.example/users/tara",
        to: [PROVIDER_ACTOR_URI],
        // object is a plain URI — cannot confirm it's a Flag
        object: "https://remote.example/flags/3",
      };

      await worker.runEnvelope("msg-19", makeEnvelope(activity, "/inbox"));

      // URI-only Undo → cannot confirm Flag type → Generic
      expect(providerClient.sendUndoFlag).not.toHaveBeenCalled();
      expect(providerClient.sendGenericEvent).toHaveBeenCalledWith(
        expect.objectContaining({ activityType: "Undo" }),
      );
    });
  });
});
