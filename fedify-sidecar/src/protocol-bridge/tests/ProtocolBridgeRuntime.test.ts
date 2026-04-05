import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { ProtocolBridgeRuntime } from "../runtime/ProtocolBridgeRuntime.js";
import { ActivityPubBridgeIngressClient } from "../runtime/ActivityPubBridgeIngressClient.js";
import type { TranslationContext } from "../ports/ProtocolBridgePorts.js";

const translationContext: TranslationContext = {
  now: () => new Date("2026-04-03T10:00:00.000Z"),
  resolveActorRef: async (ref) => ref,
  resolveObjectRef: async (ref) => ref,
};

describe("protocol bridge runtime", () => {
  it("unwraps AP source wrapper events and skips mirrored loopback wrappers", async () => {
    const apToAtWorker = {
      process: vi.fn().mockResolvedValue(null),
    };

    const runtime = new ProtocolBridgeRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "runtime-test",
        consumerGroupId: "runtime-test",
        apSourceTopic: "ap.stream1.local-public.v1",
        atCommitTopic: "at.commit.v1",
        atVerifiedIngressTopic: "at.ingress.v1",
        apIngressTopic: "ap.atproto-ingress.v1",
        enableApToAt: true,
        enableAtToAp: false,
      },
      translationContext,
      apToAtWorker: apToAtWorker as any,
    });

    await runtime.handleApSourceEvent({
      schema: "ap.outbox.committed.v1",
      activity: {
        id: "https://example.com/activities/1",
        type: "Create",
        actor: "https://example.com/users/alice",
      },
    });

    await runtime.handleApSourceEvent({
      activity: {
        id: "https://example.com/activities/2",
        type: "Create",
        actor: "https://example.com/users/alice",
      },
      bridge: {
        canonicalIntentId: "intent-2",
        sourceProtocol: "atproto",
        provenance: {
          originProtocol: "atproto",
          originEventId: "at://did:plc:alice/app.bsky.feed.post/3k2",
          mirroredFromCanonicalIntentId: "intent-2",
          projectionMode: "mirrored",
        },
      },
    });

    expect(apToAtWorker.process).toHaveBeenCalledTimes(1);
    expect(apToAtWorker.process).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "https://example.com/activities/1",
      }),
      translationContext,
    );
  });

  it("skips duplicate local AP source events that share the same outbox intent id", async () => {
    const apToAtWorker = {
      process: vi.fn().mockResolvedValue(null),
    };

    const runtime = new ProtocolBridgeRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "runtime-test",
        consumerGroupId: "runtime-test",
        apSourceTopic: "ap.stream1.local-public.v1",
        atCommitTopic: "at.commit.v1",
        atVerifiedIngressTopic: "at.ingress.v1",
        apIngressTopic: "ap.atproto-ingress.v1",
        enableApToAt: true,
        enableAtToAp: false,
      },
      translationContext,
      apToAtWorker: apToAtWorker as any,
    });

    const event = {
      outboxIntentId: "intent-duplicate-1",
      activity: {
        id: "https://example.com/activities/1",
        type: "Create",
        actor: "https://example.com/users/alice",
      },
    };

    await runtime.handleApSourceEvent(event);
    await runtime.handleApSourceEvent(event);

    expect(apToAtWorker.process).toHaveBeenCalledTimes(1);
  });

  it("fans out persisted AT commit create and delete ops into the AT->AP worker", async () => {
    const atToApWorker = {
      process: vi.fn().mockResolvedValue(null),
    };

    const runtime = new ProtocolBridgeRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "runtime-test",
        consumerGroupId: "runtime-test",
        apSourceTopic: "ap.stream1.local-public.v1",
        atCommitTopic: "at.commit.v1",
        atVerifiedIngressTopic: "at.ingress.v1",
        apIngressTopic: "ap.atproto-ingress.v1",
        enableApToAt: false,
        enableAtToAp: true,
      },
      translationContext,
      atToApWorker: atToApWorker as any,
    });

    await runtime.handleAtCommitEvent({
      did: "did:plc:alice",
      ops: [
        {
          action: "create",
          collection: "site.standard.document",
          rkey: "3karticle",
          uri: "at://did:plc:alice/site.standard.document/3karticle",
          cid: "bafy-article",
          record: {
            $type: "site.standard.document",
            title: "Article",
            text: "Body",
          },
          bridge: {
            canonicalIntentId: "intent-article",
            sourceProtocol: "activitypub",
            provenance: {
              originProtocol: "activitypub",
              originEventId: "https://example.com/activities/article",
              mirroredFromCanonicalIntentId: "intent-article",
              projectionMode: "mirrored",
            },
          },
        },
        {
          action: "delete",
          collection: "app.bsky.feed.like",
          rkey: "3kdelete",
          canonicalRefId: "canonical-like-1",
          subjectUri: "at://did:plc:bob/app.bsky.feed.post/3kpost",
          subjectCid: "bafy-post",
        },
      ],
    });

    expect(atToApWorker.process).toHaveBeenCalledTimes(2);
    expect(atToApWorker.process).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        repoDid: "did:plc:alice",
        rkey: "3karticle",
        bridge: expect.objectContaining({
          originProtocol: "activitypub",
        }),
      }),
      translationContext,
    );
    expect(atToApWorker.process).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        repoDid: "did:plc:alice",
        collection: "app.bsky.feed.like",
        operation: "delete",
        subjectUri: "at://did:plc:bob/app.bsky.feed.post/3kpost",
      }),
      translationContext,
    );
  });

  it("maps verified AT ingress commit events into the AT->AP worker shape", async () => {
    const atToApWorker = {
      process: vi.fn().mockResolvedValue(null),
    };

    const runtime = new ProtocolBridgeRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "runtime-test",
        consumerGroupId: "runtime-test",
        apSourceTopic: "ap.stream1.local-public.v1",
        atCommitTopic: "at.commit.v1",
        atVerifiedIngressTopic: "at.ingress.v1",
        apIngressTopic: "ap.atproto-ingress.v1",
        enableApToAt: false,
        enableAtToAp: true,
      },
      translationContext,
      atToApWorker: atToApWorker as any,
    });

    await runtime.handleAtVerifiedIngressEvent({
      seq: 101,
      did: "did:plc:alice",
      eventType: "#commit",
      verifiedAt: "2026-04-03T12:00:00.000Z",
      source: "wss://relay.example",
      commit: {
        rev: "3krev",
        operation: "update",
        collection: "app.bsky.feed.post",
        rkey: "3kpost",
        cid: "bafy-post",
        canonicalRefId: "canonical-post-1",
        signatureValid: true,
        record: {
          $type: "app.bsky.feed.post",
          text: "Updated text",
          createdAt: "2026-04-03T11:55:00.000Z",
        },
      },
    });

    expect(atToApWorker.process).toHaveBeenCalledTimes(1);
    expect(atToApWorker.process).toHaveBeenCalledWith(
      expect.objectContaining({
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3kpost",
        collection: "app.bsky.feed.post",
        rkey: "3kpost",
        cid: "bafy-post",
        canonicalRefId: "canonical-post-1",
        operation: "update",
        record: expect.objectContaining({
          $type: "app.bsky.feed.post",
          text: "Updated text",
        }),
      }),
      translationContext,
    );
  });

  it("delivers mirrored AP ingress events to the ActivityPods internal bridge endpoint", async () => {
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 202,
      body: {
        text: vi.fn().mockResolvedValue(""),
      },
    });

    const client = new ActivityPubBridgeIngressClient(
      {
        activityPodsBaseUrl: "http://localhost:3000",
        bearerToken: "test-token",
      },
      requestFn as any,
    );

    await client.deliver({
      version: 1,
      activityId: "https://example.com/activities/1",
      actor: "https://example.com/users/alice",
      activity: {
        id: "https://example.com/activities/1",
        type: "Create",
        actor: "https://example.com/users/alice",
      },
      bridge: {
        canonicalIntentId: "intent-1",
        sourceProtocol: "atproto",
        provenance: {
          originProtocol: "atproto",
          originEventId: "at://did:plc:alice/app.bsky.feed.post/3k1",
          mirroredFromCanonicalIntentId: "intent-1",
          projectionMode: "mirrored",
        },
      },
      receivedAt: "2026-04-03T12:00:00.000Z",
    });

    expect(requestFn).toHaveBeenCalledWith(
      "http://localhost:3000/api/internal/atproto-bridge/receive",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
        }),
      }),
    );
  });
});
