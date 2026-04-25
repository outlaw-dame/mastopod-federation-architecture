import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { DefaultAtBlobStore } from "../../at-adapter/blob/AtBlobStore.js";
import { DefaultAtBlobUploadService } from "../../at-adapter/blob/AtBlobUploadService.js";
import { DefaultBlobReferenceMapper } from "../../at-adapter/blob/BlobReferenceMapper.js";
import { RedpandaEventPublisher } from "../../core-domain/events/RedpandaEventPublisher.js";
import { AtprotoWriteGatewayPort } from "../adapters/AtprotoWriteGatewayPort.js";
import { EventPublisherActivityPubPort } from "../adapters/EventPublisherActivityPubPort.js";
import { ProtocolBridgeAdapterError } from "../adapters/ProtocolBridgeAdapterError.js";
import { ActivityPubBridgeActivityResolverClient } from "../runtime/ActivityPubBridgeActivityResolverClient.js";
import { ActivityPubBridgeOutboundResolverClient } from "../runtime/ActivityPubBridgeOutboundResolverClient.js";
import { ActivityPubBridgeProfileMediaClient } from "../runtime/ActivityPubBridgeProfileMediaClient.js";
import { AtprotoLinkPreviewThumbResolver } from "../runtime/AtprotoLinkPreviewThumbResolver.js";
import { AtprotoProfileMediaResolver } from "../runtime/AtprotoProfileMediaResolver.js";
import { InMemoryBridgeProfileMediaStore } from "../profile/BridgeProfileMedia.js";

describe("protocol bridge runtime adapters", () => {
  it("publishes sanitized RedPanda events with deterministic metadata headers", async () => {
    const nested: Record<string, unknown> = { ok: true };
    nested["__proto__"] = "drop-me";
    const producer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const publisher = new RedpandaEventPublisher(
      {
        brokers: ["localhost:9092"],
        clientId: "test-events",
        compression: "none",
      },
      producer,
    );

    await publisher.publish(
      "at.commit.v1",
      {
        version: 1,
        did: "did:plc:alice",
        emittedAt: "2026-04-03T12:00:00.000Z",
        nested,
      } as any,
      {
        source: "test-suite",
        partitionKey: "did:plc:alice",
        correlationId: "intent-1",
      },
    );

    expect(producer.connect).toHaveBeenCalledTimes(1);
    expect(producer.send).toHaveBeenCalledTimes(1);

    const sendCall = producer.send.mock.calls[0]?.[0];
    expect(sendCall.topic).toBe("at.commit.v1");
    const payload = JSON.parse(sendCall.messages[0].value);
    expect(payload.did).toBe("did:plc:alice");
    expect(payload.nested.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payload.nested, "__proto__")).toBe(false);
    expect(sendCall.messages[0].headers["partition-key"]).toBe("did:plc:alice");
    expect(sendCall.messages[0].headers["correlation-id"]).toBe("intent-1");
  });

  it("routes projected AT writes through the native gateway for a local managed repo", async () => {
    const nested: Record<string, unknown> = { safe: true };
    nested["__proto__"] = "drop-me";
    const writeGateway = {
      createRecord: vi.fn().mockResolvedValue({}),
      putRecord: vi.fn().mockResolvedValue({}),
      deleteRecord: vi.fn().mockResolvedValue({}),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        webId: "https://example.com/alice/profile/card#me",
        status: "active",
        atprotoManaged: true,
        atprotoSource: "local",
        atprotoPdsUrl: "https://pds.example.com",
      }),
    };

    const port = new AtprotoWriteGatewayPort(writeGateway as any, accountResolver as any);
    await port.apply([
      {
        kind: "createRecord",
        collection: "app.bsky.feed.post",
        repoDid: "did:plc:alice",
        rkey: "fixedpost12345",
        record: {
          text: "hello",
          nested,
        },
      },
      {
        kind: "updateRecord",
        collection: "app.bsky.actor.profile",
        repoDid: "did:plc:alice",
        rkey: "self",
        record: {
          displayName: "Alice",
        },
      },
      {
        kind: "deleteRecord",
        collection: "app.bsky.feed.repost",
        repoDid: "did:plc:alice",
        rkey: "3kdel",
      },
    ]);

    expect(accountResolver.resolveByIdentifier).toHaveBeenCalledWith("did:plc:alice");
    expect(writeGateway.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "did:plc:alice",
        collection: "app.bsky.feed.post",
        rkey: "fixedpost12345",
        record: expect.objectContaining({
          text: "hello",
          nested: { safe: true },
        }),
      }),
      expect.objectContaining({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        scope: "full",
      }),
    );
    expect(writeGateway.putRecord).toHaveBeenCalledTimes(1);
    expect(writeGateway.deleteRecord).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid projected AT rkeys before hitting the native gateway", async () => {
    const writeGateway = {
      createRecord: vi.fn(),
      putRecord: vi.fn(),
      deleteRecord: vi.fn(),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn(),
    };

    const port = new AtprotoWriteGatewayPort(writeGateway as any, accountResolver as any);

    await expect(port.apply([
      {
        kind: "createRecord",
        collection: "app.bsky.feed.post",
        repoDid: "did:plc:alice",
        rkey: "bad/rkey",
        record: {
          text: "hello",
        },
      },
    ])).rejects.toMatchObject({
      code: "AT_BRIDGE_RKEY_INVALID",
    });

    expect(accountResolver.resolveByIdentifier).not.toHaveBeenCalled();
    expect(writeGateway.createRecord).not.toHaveBeenCalled();
  });

  it("routes projected longform AT writes through the native gateway with bridge metadata hints", async () => {
    const writeGateway = {
      createRecord: vi.fn().mockResolvedValue({}),
      putRecord: vi.fn(),
      deleteRecord: vi.fn(),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        webId: "https://example.com/alice/profile/card#me",
        status: "active",
        atprotoManaged: true,
        atprotoSource: "local",
        atprotoPdsUrl: "https://pds.example.com",
      }),
    };

    const port = new AtprotoWriteGatewayPort(writeGateway as any, accountResolver as any);
    await port.apply([
      {
        kind: "createRecord",
        collection: "site.standard.document",
        repoDid: "did:plc:alice",
        canonicalRefIdHint: "canonical-article-1",
        record: { $type: "site.standard.document", text: "article" },
        metadata: {
          canonicalIntentId: "intent-article-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/article-1",
            mirroredFromCanonicalIntentId: "intent-article-1",
            projectionMode: "mirrored",
          },
        },
      },
    ]);

    expect(accountResolver.resolveByIdentifier).toHaveBeenCalledWith("did:plc:alice");
    expect(writeGateway.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: "site.standard.document",
        record: expect.objectContaining({
          $type: "site.standard.document",
          text: "article",
          _bridgeCanonicalRefId: "canonical-article-1",
          _bridgeMetadata: expect.objectContaining({
            canonicalIntentId: "intent-article-1",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("uploads external-card thumbnails into AT blob refs before calling the native gateway", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          mediaUrl: "https://cdn.example.com/card.png",
          mimeType: "image/png",
          bytesBase64: pngBytes.toString("base64"),
          size: pngBytes.byteLength,
        })),
      },
    });
    const resolver = new AtprotoLinkPreviewThumbResolver(
      new ActivityPubBridgeProfileMediaClient(
        {
          activityPodsBaseUrl: "http://localhost:3000",
          bearerToken: "test-token",
        },
        requestFn as any,
      ),
      new DefaultAtBlobUploadService(new DefaultAtBlobStore(), new DefaultBlobReferenceMapper()),
    );
    const writeGateway = {
      createRecord: vi.fn().mockResolvedValue({}),
      putRecord: vi.fn(),
      deleteRecord: vi.fn(),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        webId: "https://example.com/alice/profile/card#me",
        status: "active",
        atprotoManaged: true,
        atprotoSource: "local",
        atprotoPdsUrl: "https://pds.example.com",
      }),
    };

    const port = new AtprotoWriteGatewayPort(writeGateway as any, accountResolver as any, {
      linkPreviewThumbResolver: resolver,
    });
    await port.apply([
      {
        kind: "createRecord",
        collection: "app.bsky.feed.post",
        repoDid: "did:plc:alice",
        rkey: "fixedpost12345",
        linkPreviewThumbUrlHint: "https://cdn.example.com/card.png",
        record: {
          $type: "app.bsky.feed.post",
          text: "Bridge article teaser",
          embed: {
            $type: "app.bsky.embed.external",
            external: {
              uri: "https://example.com/articles/1",
              title: "Bridge article",
              description: "Preview text",
            },
          },
        },
      },
    ]);

    expect(writeGateway.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: "app.bsky.feed.post",
        record: expect.objectContaining({
          embed: {
            $type: "app.bsky.embed.external",
            external: expect.objectContaining({
              uri: "https://example.com/articles/1",
              thumb: expect.objectContaining({
                $type: "blob",
                mimeType: "image/png",
              }),
            }),
          },
        }),
      }),
      expect.anything(),
    );
  });

  it("continues projected AT writes without thumbnail blobs when external-card thumb resolution fails", async () => {
    const writeGateway = {
      createRecord: vi.fn().mockResolvedValue({}),
      putRecord: vi.fn(),
      deleteRecord: vi.fn(),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        webId: "https://example.com/alice/profile/card#me",
        status: "active",
        atprotoManaged: true,
        atprotoSource: "local",
        atprotoPdsUrl: "https://pds.example.com",
      }),
    };
    const logger = {
      warn: vi.fn(),
    };
    const resolver = {
      resolveThumbBlob: vi.fn().mockRejectedValue(new Error("temporary media timeout")),
    };

    const port = new AtprotoWriteGatewayPort(writeGateway as any, accountResolver as any, {
      linkPreviewThumbResolver: resolver as any,
      logger,
    });
    await port.apply([
      {
        kind: "createRecord",
        collection: "app.bsky.feed.post",
        repoDid: "did:plc:alice",
        rkey: "fixedpost12345",
        linkPreviewThumbUrlHint: "https://cdn.example.com/card.png",
        record: {
          $type: "app.bsky.feed.post",
          text: "Bridge article teaser",
          embed: {
            $type: "app.bsky.embed.external",
            external: {
              uri: "https://example.com/articles/1",
              title: "Bridge article",
              description: "Preview text",
            },
          },
        },
      },
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(writeGateway.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          embed: {
            $type: "app.bsky.embed.external",
            external: {
              uri: "https://example.com/articles/1",
              title: "Bridge article",
              description: "Preview text",
            },
          },
        }),
      }),
      expect.anything(),
    );
  });

  it("routes projected AT deletes through the native gateway with bridge provenance", async () => {
    const writeGateway = {
      createRecord: vi.fn(),
      putRecord: vi.fn(),
      deleteRecord: vi.fn().mockResolvedValue({}),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        webId: "https://example.com/alice/profile/card#me",
        status: "active",
        atprotoManaged: true,
        atprotoSource: "local",
        atprotoPdsUrl: "https://pds.example.com",
      }),
    };

    const port = new AtprotoWriteGatewayPort(writeGateway as any, accountResolver as any);
    await port.apply([
      {
        kind: "deleteRecord",
        collection: "app.bsky.feed.like",
        repoDid: "did:plc:alice",
        rkey: "3klike",
        canonicalRefIdHint: "canonical-like-1",
        metadata: {
          canonicalIntentId: "intent-like-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/undo-like-1",
            mirroredFromCanonicalIntentId: "intent-like-1",
            projectionMode: "mirrored",
          },
        },
      },
    ]);

    expect(writeGateway.deleteRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: "app.bsky.feed.like",
        rkey: "3klike",
        bridgeCanonicalRefId: "canonical-like-1",
        bridgeMetadata: expect.objectContaining({
          canonicalIntentId: "intent-like-1",
        }),
      }),
      expect.anything(),
    );
  });

  it("publishes bridge ingress envelopes for AT-to-AP projection", async () => {
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      publishBatch: vi.fn().mockResolvedValue(undefined),
    };

    const port = new EventPublisherActivityPubPort(eventPublisher as any, {
      now: () => new Date("2026-04-03T12:00:00.000Z"),
    });

    await port.publish([
      {
        kind: "publishActivity",
        targetTopic: "ap.atproto-ingress.v1",
        activity: {
          id: "https://example.com/activities/1",
          type: "Create",
          actor: "https://example.com/users/alice",
          object: {
            id: "https://example.com/notes/1",
            type: "Note",
            content: "Hello",
          },
        },
        metadata: {
          canonicalIntentId: "intent-1",
          sourceProtocol: "atproto",
          provenance: {
            originProtocol: "atproto",
            originEventId: "at://did:plc:alice/app.bsky.feed.post/3k123",
            mirroredFromCanonicalIntentId: "intent-1",
            projectionMode: "mirrored",
          },
        },
      },
    ]);

    expect(eventPublisher.publish).toHaveBeenCalledWith(
      "ap.atproto-ingress.v1",
      expect.objectContaining({
        version: 1,
        activityId: "https://example.com/activities/1",
        actor: "https://example.com/users/alice",
        bridge: expect.objectContaining({
          canonicalIntentId: "intent-1",
        }),
      }),
      expect.objectContaining({
        correlationId: "intent-1",
        partitionKey: "https://example.com/users/alice",
      }),
    );
  });

  it("refuses outbound AP publish when recipient resolution is not available", async () => {
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      publishBatch: vi.fn().mockResolvedValue(undefined),
    };

    const port = new EventPublisherActivityPubPort(eventPublisher as any);
    await expect(port.publish([
      {
        kind: "publishActivity",
        targetTopic: "ap.outbound.v1",
        activity: {
          id: "https://example.com/activities/2",
          type: "Create",
          actor: "https://example.com/users/alice",
        },
        metadata: {
          canonicalIntentId: "intent-2",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/2",
            mirroredFromCanonicalIntentId: null,
            projectionMode: "native",
          },
        },
      },
    ])).rejects.toMatchObject({
      code: "AP_OUTBOUND_RECIPIENT_RESOLUTION_REQUIRED",
    });

    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("publishes one outbound event per resolved target domain", async () => {
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      publishBatch: vi.fn().mockResolvedValue(undefined),
    };
    const outboundResolver = {
      resolve: vi.fn().mockResolvedValue([
        {
          actor: "https://example.com/users/alice",
          targetDomain: "example.net",
          recipients: ["https://example.net/inbox"],
        },
        {
          actor: "https://example.com/users/alice",
          targetDomain: "example.org",
          recipients: ["https://example.org/shared-inbox"],
          sharedInbox: "https://example.org/shared-inbox",
        },
      ]),
    };

    const port = new EventPublisherActivityPubPort(eventPublisher as any, {
      outboundResolver: outboundResolver as any,
      now: () => new Date("2026-04-03T12:00:00.000Z"),
    });

    await port.publish([
      {
        kind: "publishActivity",
        targetTopic: "ap.outbound.v1",
        activity: {
          id: "https://example.com/activities/3",
          type: "Create",
          actor: "https://example.com/users/alice",
        },
        metadata: {
          canonicalIntentId: "intent-3",
          sourceProtocol: "atproto",
          provenance: {
            originProtocol: "atproto",
            originEventId: "at://did:plc:alice/app.bsky.feed.post/3k3",
            mirroredFromCanonicalIntentId: "intent-3",
            projectionMode: "mirrored",
          },
        },
      },
    ]);

    expect(outboundResolver.resolve).toHaveBeenCalledTimes(1);
    expect(eventPublisher.publish).toHaveBeenCalledTimes(2);
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      1,
      "ap.outbound.v1",
      expect.objectContaining({
        targetDomain: "example.net",
        recipients: ["https://example.net/inbox"],
      }),
      expect.objectContaining({
        partitionKey: "example.net",
      }),
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      "ap.outbound.v1",
      expect.objectContaining({
        targetDomain: "example.org",
        sharedInbox: "https://example.org/shared-inbox",
        recipients: ["https://example.org/shared-inbox"],
      }),
      expect.objectContaining({
        partitionKey: "example.org",
      }),
    );
  });

  it("tailors outbound AP note preview shape per target domain policy", async () => {
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      publishBatch: vi.fn().mockResolvedValue(undefined),
    };
    const outboundResolver = {
      resolve: vi.fn().mockResolvedValue([
        {
          actor: "https://example.com/users/alice",
          targetDomain: "mastodon.social",
          recipients: ["https://mastodon.social/inbox"],
        },
        {
          actor: "https://example.com/users/alice",
          targetDomain: "rich.example",
          recipients: ["https://rich.example/inbox"],
        },
      ]),
    };

    const port = new EventPublisherActivityPubPort(eventPublisher as any, {
      outboundResolver: outboundResolver as any,
      deliveryPolicy: {
        defaultNoteLinkPreviewMode: "attachment_only",
        richNoteLinkPreviewDomains: ["rich.example"],
        disabledNoteLinkPreviewDomains: ["mastodon.social"],
      },
    });

    await port.publish([
      {
        kind: "publishActivity",
        targetTopic: "ap.outbound.v1",
        activity: {
          id: "https://example.com/activities/preview-1",
          type: "Create",
          actor: "https://example.com/users/alice",
          object: {
            type: "Note",
            content: "<p>Check this out</p>",
            attachment: [
              {
                type: "Link",
                mediaType: "text/html",
                href: "https://example.com/page",
                name: "Example Page",
                preview: {
                  type: "Article",
                  name: "Example Page",
                },
              },
              {
                type: "Image",
                mediaType: "image/png",
                url: "https://cdn.example.com/photo.png",
              },
            ],
          },
        },
        metadata: {
          canonicalIntentId: "intent-preview-1",
          sourceProtocol: "atproto",
          provenance: {
            originProtocol: "atproto",
            originEventId: "at://did:plc:alice/app.bsky.feed.post/3preview",
            mirroredFromCanonicalIntentId: "intent-preview-1",
            projectionMode: "mirrored",
          },
          activityPubHints: {
            noteLinkPreviewUrls: ["https://example.com/page"],
          },
        },
      },
    ]);

    const disabledEvent = eventPublisher.publish.mock.calls[0]?.[1];
    const richEvent = eventPublisher.publish.mock.calls[1]?.[1];

    expect(disabledEvent.activity.object.preview).toBeUndefined();
    expect(disabledEvent.activity.object.attachment).toEqual([
      expect.objectContaining({
        type: "Image",
        url: "https://cdn.example.com/photo.png",
      }),
    ]);

    expect(richEvent.activity.object.preview).toEqual(
      expect.objectContaining({
        type: "Link",
        href: "https://example.com/page",
      }),
    );
    expect(richEvent.activity.object.attachment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "Link",
          href: "https://example.com/page",
        }),
      ]),
    );
  });

  it("resolves outbound ActivityPub deliveries through the trusted internal resolver endpoint", async () => {
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          actorUri: "https://example.com/users/alice",
          deliveries: [
            {
              actor: "https://example.com/users/alice",
              targetDomain: "example.net",
              recipients: ["https://example.net/inbox"],
            },
          ],
          resolvedAt: "2026-04-03T12:00:00.000Z",
        })),
      },
    });

    const client = new ActivityPubBridgeOutboundResolverClient(
      {
        activityPodsBaseUrl: "http://localhost:3000",
        bearerToken: "test-token",
      },
      requestFn as any,
    );

    const deliveries = await client.resolve(
      {
        kind: "publishActivity",
        targetTopic: "ap.outbound.v1",
        activity: {
          id: "https://example.com/activities/4",
          type: "Create",
          actor: "https://example.com/users/alice",
        },
        metadata: {
          canonicalIntentId: "intent-4",
          sourceProtocol: "atproto",
          provenance: {
            originProtocol: "atproto",
            originEventId: "at://did:plc:alice/app.bsky.feed.post/3k4",
            mirroredFromCanonicalIntentId: "intent-4",
            projectionMode: "mirrored",
          },
        },
      },
      {
        id: "https://example.com/activities/4",
        type: "Create",
        actor: "https://example.com/users/alice",
      },
    );

    expect(deliveries).toEqual([
      {
        actor: "https://example.com/users/alice",
        targetDomain: "example.net",
        recipients: ["https://example.net/inbox"],
      },
    ]);
    expect(requestFn).toHaveBeenCalledWith(
      "http://localhost:3000/api/internal/activitypub-bridge/resolve-outbound",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("resolves remote ActivityPub Undo target activities through the trusted internal resolver endpoint", async () => {
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          activityId: "https://remote.example/activities/like-9",
          activity: {
            id: "https://remote.example/activities/like-9",
            type: "Like",
            actor: "https://example.com/users/alice",
            object: "https://remote.example/notes/9",
            "__proto__": {
              polluted: true,
            },
          },
          resolvedAt: "2026-04-03T12:05:00.000Z",
        })),
      },
    });

    const client = new ActivityPubBridgeActivityResolverClient(
      {
        activityPodsBaseUrl: "http://localhost:3000",
        bearerToken: "test-token",
      },
      requestFn as any,
    );

    const activity = await client.resolveActivityObject(
      "https://remote.example/activities/like-9",
      { expectedActorUri: "https://example.com/users/alice" },
    );

    expect(activity).toEqual({
      id: "https://remote.example/activities/like-9",
      type: "Like",
      actor: "https://example.com/users/alice",
      object: "https://remote.example/notes/9",
    });
    expect(Object.prototype.hasOwnProperty.call(activity ?? {}, "__proto__")).toBe(false);
    expect(requestFn).toHaveBeenCalledWith(
      "http://localhost:3000/api/internal/activitypub-bridge/resolve-activity",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
        }),
        body: JSON.stringify({
          activityId: "https://remote.example/activities/like-9",
          expectedActorUri: "https://example.com/users/alice",
        }),
      }),
    );
  });

  it("treats missing remote ActivityPub Undo target activities as unresolved instead of failing the bridge", async () => {
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 404,
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: "not_found",
          message: "Remote activity could not be resolved.",
        })),
      },
    });

    const client = new ActivityPubBridgeActivityResolverClient(
      {
        activityPodsBaseUrl: "http://localhost:3000",
        bearerToken: "test-token",
      },
      requestFn as any,
    );

    await expect(client.resolveActivityObject("https://remote.example/activities/missing")).resolves.toBeNull();
  });

  it("resolves profile media through the trusted internal media endpoint", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          mediaUrl: "https://cdn.example.com/avatar.png",
          mimeType: "image/png",
          bytesBase64: pngBytes.toString("base64"),
          size: pngBytes.byteLength,
          resolvedAt: "2026-04-03T12:10:00.000Z",
        })),
      },
    });

    const client = new ActivityPubBridgeProfileMediaClient(
      {
        activityPodsBaseUrl: "http://localhost:3000",
        bearerToken: "test-token",
      },
      requestFn as any,
    );

    const resolved = await client.resolve("https://cdn.example.com/avatar.png");
    expect(resolved).toEqual({
      mediaUrl: "https://cdn.example.com/avatar.png",
      mimeType: "image/png",
      size: pngBytes.byteLength,
      bytes: new Uint8Array(pngBytes),
    });
    expect(requestFn).toHaveBeenCalledWith(
      "http://localhost:3000/api/internal/activitypub-bridge/resolve-profile-media",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
        }),
        body: JSON.stringify({
          mediaUrl: "https://cdn.example.com/avatar.png",
          maxBytes: 5242880,
        }),
      }),
    );
  });

  it("omits unresolved profile media instead of failing non-transiently", async () => {
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 415,
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: "unsupported_media_type",
          message: "Only raster images are supported",
        })),
      },
    });
    const store = new InMemoryBridgeProfileMediaStore();
    await store.put({
      mediaId: "avatar-1",
      ownerDid: "did:plc:alice",
      role: "avatar",
      sourceUrl: "https://cdn.example.com/avatar.svg",
      mimeType: "image/png",
      createdAt: "2026-04-03T12:00:00.000Z",
    });

    const resolver = new AtprotoProfileMediaResolver(
      store,
      new ActivityPubBridgeProfileMediaClient(
        {
          activityPodsBaseUrl: "http://localhost:3000",
          bearerToken: "test-token",
        },
        requestFn as any,
      ),
      new DefaultAtBlobUploadService(new DefaultAtBlobStore(), new DefaultBlobReferenceMapper()),
    );

    await expect(resolver.resolveAvatarBlob("avatar-1")).resolves.toBeNull();
  });

  it("uploads resolved profile media into AT blob refs for native profile serialization", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const requestFn = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          mediaUrl: "https://cdn.example.com/banner.png",
          mimeType: "image/png",
          bytesBase64: pngBytes.toString("base64"),
          size: pngBytes.byteLength,
        })),
      },
    });
    const store = new InMemoryBridgeProfileMediaStore();
    await store.put({
      mediaId: "banner-1",
      ownerDid: "did:plc:alice",
      role: "banner",
      sourceUrl: "https://cdn.example.com/banner.png",
      mimeType: "image/png",
      createdAt: "2026-04-03T12:00:00.000Z",
    });

    const resolver = new AtprotoProfileMediaResolver(
      store,
      new ActivityPubBridgeProfileMediaClient(
        {
          activityPodsBaseUrl: "http://localhost:3000",
          bearerToken: "test-token",
        },
        requestFn as any,
      ),
      new DefaultAtBlobUploadService(new DefaultAtBlobStore(), new DefaultBlobReferenceMapper()),
    );

    await expect(resolver.resolveBannerBlob("banner-1")).resolves.toEqual(
      expect.objectContaining({
        $type: "blob",
        mimeType: "image/png",
      }),
    );
  });
});
