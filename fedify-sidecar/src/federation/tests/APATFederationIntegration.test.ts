/**
 * Federation Integration Tests: ActivityPods <-> AT Protocol via Fedify Sidecar
 */

import { describe, expect, it, beforeAll } from "vitest";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { createProtocolBridgeContexts } from "../../protocol-bridge/runtime/createProtocolBridgeContexts.js";
import { AtprotoToCanonicalTranslator } from "../../protocol-bridge/atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../../protocol-bridge/projectors/CanonicalToActivityPubProjector.js";
import { ActivityPubToCanonicalTranslator } from "../../protocol-bridge/activitypub/ActivityPubToCanonicalTranslator.js";
import { CanonicalToAtprotoProjector } from "../../protocol-bridge/projectors/CanonicalToAtprotoProjector.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function createMockIdentityRepo() {
  const bindings = [
    {
      canonicalAccountId: "acct:alice",
      atprotoDid: "did:plc:alice1234567890",
      atprotoHandle: "alice.bsky.social",
      activityPubActorUri: "https://fed.example.com/users/alice",
      webId: "https://fed.example.com/alice/profile/card#me",
      status: "active" as const,
    },
    {
      canonicalAccountId: "acct:bob",
      atprotoDid: "did:plc:bob1234567890abcd",
      atprotoHandle: "bob.bsky.social",
      activityPubActorUri: "https://fed.example.com/users/bob",
      webId: "https://fed.example.com/bob/profile/card#me",
      status: "active" as const,
    },
  ];

  return {
    getByCanonicalAccountId: async (id: string) =>
      bindings.find((b) => b.canonicalAccountId === id) || null,
    getByAtprotoDid: async (did: string) =>
      bindings.find((b) => b.atprotoDid === did) || null,
    getByActivityPubActorUri: async (uri: string) =>
      bindings.find((b) => b.activityPubActorUri === uri) || null,
    getByAtprotoHandle: async (handle: string) =>
      bindings.find((b) => b.atprotoHandle === handle) || null,
  };
}

describe("Inbound Federation: AT Protocol -> ActivityPods", () => {
  let aliasStore: InMemoryAtAliasStore;
  let identityRepo: any;

  const aliceDid = "did:plc:alice1234567890";
  const bobDid = "did:plc:bob1234567890abcd";

  beforeAll(() => {
    aliasStore = new InMemoryAtAliasStore();
    identityRepo = createMockIdentityRepo();
  });

  it("converts AT post into AP Create{Note}", async () => {
    const { translationContext, projectionContext } = createProtocolBridgeContexts(identityRepo, aliasStore);

    await aliasStore.put({
      canonicalRefId: "alice-post-1",
      canonicalType: "post",
      did: aliceDid,
      collection: "app.bsky.feed.post",
      rkey: "post1",
      atUri: `at://${aliceDid}/app.bsky.feed.post/post1`,
      canonicalUrl: `https://bsky.app/profile/${aliceDid}/post/post1`,
      createdAt: "2026-04-03T10:00:00.000Z",
      updatedAt: "2026-04-03T10:00:00.000Z",
    });

    const atRecord = {
      repoDid: aliceDid,
      uri: `at://${aliceDid}/app.bsky.feed.post/post1`,
      rkey: "post1",
      canonicalRefId: "alice-post-1",
      operation: "create" as const,
      record: {
        $type: "app.bsky.feed.post",
        text: "Hello from Bluesky!",
        createdAt: "2026-04-03T10:00:00.000Z",
      },
    };

    const translator = new AtprotoToCanonicalTranslator();
    const canonicalIntent = await translator.translate(atRecord, translationContext);
    expect(canonicalIntent?.kind).toBe("PostCreate");

    const projector = new CanonicalToActivityPubProjector();
    const apProjection = await projector.project(canonicalIntent!, projectionContext);
    expect(apProjection.kind).toBe("success");
    if (apProjection.kind !== "success") return;

    const activity = asRecord(apProjection.commands[0]?.activity);
    const object = asRecord(activity?.["object"]);
    expect(activity?.["type"]).toBe("Create");
    expect(object?.["type"]).toBe("Note");
    expect(String(object?.["content"] ?? "")).toContain("Hello from Bluesky!");
  });

  it("converts AT like/follow into AP Like/Follow", async () => {
    const { translationContext, projectionContext } = createProtocolBridgeContexts(identityRepo, aliasStore);

    await aliasStore.put({
      canonicalRefId: "bob-post-liked",
      canonicalType: "post",
      did: bobDid,
      collection: "app.bsky.feed.post",
      rkey: "liked",
      atUri: `at://${bobDid}/app.bsky.feed.post/liked`,
      canonicalUrl: `https://bsky.app/profile/${bobDid}/post/liked`,
      createdAt: "2026-04-03T09:00:00.000Z",
      updatedAt: "2026-04-03T09:00:00.000Z",
    });

    const atLike = {
      repoDid: aliceDid,
      uri: `at://${aliceDid}/app.bsky.feed.like/like1`,
      rkey: "like1",
      canonicalRefId: "alice-like-bob",
      operation: "create" as const,
      record: {
        $type: "app.bsky.feed.like",
        subject: { uri: `at://${bobDid}/app.bsky.feed.post/liked`, cid: "bagcid1" },
        createdAt: "2026-04-03T10:45:00.000Z",
      },
    };

    const likeIntent = await new AtprotoToCanonicalTranslator().translate(atLike, translationContext);
    expect(likeIntent?.kind).toBe("ReactionAdd");

    const likeProjection = await new CanonicalToActivityPubProjector().project(likeIntent!, projectionContext);
    expect(likeProjection.kind).toBe("success");
    if (likeProjection.kind === "success") {
      const activity = asRecord(likeProjection.commands[0]?.activity);
      expect(activity?.["type"]).toBe("Like");
    }

    const atFollow = {
      repoDid: aliceDid,
      uri: `at://${aliceDid}/app.bsky.graph.follow/follow1`,
      rkey: "follow1",
      canonicalRefId: "alice-follow-bob",
      operation: "create" as const,
      record: {
        $type: "app.bsky.graph.follow",
        subject: bobDid,
        createdAt: "2026-04-03T11:00:00.000Z",
      },
    };

    const followIntent = await new AtprotoToCanonicalTranslator().translate(atFollow, translationContext);
    expect(followIntent?.kind).toBe("FollowAdd");

    const followProjection = await new CanonicalToActivityPubProjector().project(followIntent!, projectionContext);
    expect(followProjection.kind).toBe("success");
    if (followProjection.kind === "success") {
      const activity = asRecord(followProjection.commands[0]?.activity);
      expect(activity?.["type"]).toBe("Follow");
    }
  });

  it("preserves reply fidelity from AT reply parent to AP inReplyTo", async () => {
    const { translationContext, projectionContext } = createProtocolBridgeContexts(identityRepo, aliasStore);

    await aliasStore.put({
      canonicalRefId: "canonical-parent-note-1",
      canonicalType: "post",
      did: aliceDid,
      collection: "app.bsky.feed.post",
      rkey: "3kparent",
      atUri: "at://did:plc:alice1234567890/app.bsky.feed.post/3kparent",
      canonicalUrl: "https://bsky.app/profile/did:plc:alice1234567890/post/3kparent",
      createdAt: "2026-04-03T10:00:00.000Z",
      updatedAt: "2026-04-03T10:00:00.000Z",
    });

    await aliasStore.put({
      canonicalRefId: "canonical-reply-note-1",
      canonicalType: "post",
      did: aliceDid,
      collection: "app.bsky.feed.post",
      rkey: "3kreply",
      atUri: "at://did:plc:alice1234567890/app.bsky.feed.post/3kreply",
      canonicalUrl: "https://bsky.app/profile/did:plc:alice1234567890/post/3kreply",
      createdAt: "2026-04-03T10:01:00.000Z",
      updatedAt: "2026-04-03T10:01:00.000Z",
    });

    const intent = await new AtprotoToCanonicalTranslator().translate(
      {
        repoDid: aliceDid,
        uri: "at://did:plc:alice1234567890/app.bsky.feed.post/3kreply",
        rkey: "3kreply",
        canonicalRefId: "canonical-reply-note-1",
        operation: "create",
        record: {
          $type: "app.bsky.feed.post",
          text: "Reply body",
          reply: {
            parent: {
              uri: "at://did:plc:alice1234567890/app.bsky.feed.post/3kparent",
              cid: "bafy-parent",
            },
            root: {
              uri: "at://did:plc:alice1234567890/app.bsky.feed.post/3kparent",
              cid: "bafy-parent",
            },
          },
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent) return;

    const projected = await new CanonicalToActivityPubProjector().project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        object: expect.objectContaining({
          inReplyTo: "https://bsky.app/profile/did:plc:alice1234567890/post/3kparent",
        }),
      }),
    );
  });
});

describe("Outbound Federation: ActivityPods -> AT Protocol", () => {
  let aliasStore: InMemoryAtAliasStore;
  let identityRepo: any;

  const aliceUri = "https://fed.example.com/users/alice";
  const bobUri = "https://fed.example.com/users/bob";

  beforeAll(() => {
    aliasStore = new InMemoryAtAliasStore();
    identityRepo = createMockIdentityRepo();
  });

  it("converts AP Create{Note} into AT post record", async () => {
    const { translationContext, projectionContext } = createProtocolBridgeContexts(identityRepo, aliasStore);

    const apCreate = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Create",
      id: `${aliceUri}/activities/create-note-1`,
      actor: aliceUri,
      object: {
        type: "Note",
        id: `${aliceUri}/objects/note-1`,
        attributedTo: aliceUri,
        content: "Hello from ActivityPods!",
        published: "2026-04-03T10:00:00.000Z",
        url: `${aliceUri}/objects/note-1`,
      },
      published: "2026-04-03T10:00:00.000Z",
    };

    const translator = new ActivityPubToCanonicalTranslator();
    const canonicalIntent = await translator.translate(apCreate, translationContext);
    expect(canonicalIntent?.kind).toBe("PostCreate");

    const projector = new CanonicalToAtprotoProjector();
    const atProjection = await projector.project(canonicalIntent!, projectionContext);
    expect(atProjection.kind).toBe("success");
    if (atProjection.kind === "success") {
      const record = asRecord(atProjection.commands[0]?.record);
      expect(record?.["$type"]).toBe("app.bsky.feed.post");
      expect(record?.["text"]).toBe("Hello from ActivityPods!");
    }
  });

  it("recognizes outbound AP Like and Follow", async () => {
    const { translationContext, projectionContext } = createProtocolBridgeContexts(identityRepo, aliasStore);

    const apLike = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Like",
      id: `${aliceUri}/activities/like-1`,
      actor: aliceUri,
      object: `${bobUri}/notes/1`,
      published: "2026-04-03T10:45:00.000Z",
    };

    const likeIntent = await new ActivityPubToCanonicalTranslator().translate(apLike, translationContext);
    expect(likeIntent?.kind).toBe("ReactionAdd");

    const apFollow = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Follow",
      id: `${aliceUri}/activities/follow-1`,
      actor: aliceUri,
      object: bobUri,
      published: "2026-04-03T11:00:00.000Z",
    };

    const followIntent = await new ActivityPubToCanonicalTranslator().translate(apFollow, translationContext);
    expect(followIntent?.kind).toBe("FollowAdd");

    const atProjection = await new CanonicalToAtprotoProjector().project(followIntent!, projectionContext);
    if (atProjection.kind === "success") {
      const record = asRecord(atProjection.commands[0]?.record);
      expect(record?.["$type"]).toBe("app.bsky.graph.follow");
    }
  });

  it("projects outbound AP Like when alias resolution provides atUri and cid", async () => {
    const { translationContext, projectionContext } = createProtocolBridgeContexts(identityRepo, aliasStore);

    await aliasStore.put({
      canonicalRefId: "https://fed.example.com/objects/liked-1",
      canonicalType: "post",
      did: "did:plc:bob1234567890abcd",
      collection: "app.bsky.feed.post",
      rkey: "liked1",
      atUri: "at://did:plc:bob1234567890abcd/app.bsky.feed.post/liked1",
      cid: "bafy-liked-1",
      canonicalUrl: "https://bsky.app/profile/did:plc:bob1234567890abcd/post/liked1",
      createdAt: "2026-04-03T12:00:00.000Z",
      updatedAt: "2026-04-03T12:00:00.000Z",
    });

    const likeIntent = await new ActivityPubToCanonicalTranslator().translate(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Like",
        id: `${aliceUri}/activities/like-alias-1`,
        actor: aliceUri,
        object: "https://fed.example.com/objects/liked-1",
        published: "2026-04-03T12:01:00.000Z",
      },
      translationContext,
    );

    expect(likeIntent?.kind).toBe("ReactionAdd");
    if (!likeIntent) return;

    const projection = await new CanonicalToAtprotoProjector().project(likeIntent, projectionContext);
    expect(projection.kind).toBe("success");
    if (projection.kind !== "success") return;

    expect(projection.commands[0]).toEqual(
      expect.objectContaining({
        collection: "app.bsky.feed.like",
        record: expect.objectContaining({
          $type: "app.bsky.feed.like",
          subject: {
            uri: "at://did:plc:bob1234567890abcd/app.bsky.feed.post/liked1",
            cid: "bafy-liked-1",
          },
        }),
      }),
    );
  });
});
