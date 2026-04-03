import { describe, expect, it, vi } from "vitest";
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
