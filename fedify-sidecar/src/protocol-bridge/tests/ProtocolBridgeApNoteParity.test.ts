import { describe, expect, it } from "vitest";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { createProtocolBridgeContexts } from "../runtime/createProtocolBridgeContexts.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";

function createIdentityRepo() {
  const binding = {
    canonicalAccountId: "acct:alice",
    atprotoDid: "did:plc:alice",
    atprotoHandle: "alice.example.com",
    activityPubActorUri: "https://example.com/users/alice",
    webId: "https://example.com/alice/profile/card#me",
    status: "active",
  };

  return {
    getByCanonicalAccountId: async (canonicalAccountId: string) =>
      canonicalAccountId === binding.canonicalAccountId ? binding : null,
    getByAtprotoDid: async (did: string) =>
      did === binding.atprotoDid ? binding : null,
    getByActivityPubActorUri: async (activityPubActorUri: string) =>
      activityPubActorUri === binding.activityPubActorUri ? binding : null,
    getByWebId: async (webId: string) =>
      webId === binding.webId ? binding : null,
    getByAtprotoHandle: async (handle: string) =>
      handle === binding.atprotoHandle ? binding : null,
  };
}

describe("AP-side note parity", () => {
  it("projects AT note updates to the same AP object id when only alias-backed note URL remains", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "canonical-note-1",
      canonicalType: "post",
      did: "did:plc:alice",
      collection: "app.bsky.feed.post",
      rkey: "3knote",
      atUri: "at://did:plc:alice/app.bsky.feed.post/3knote",
      canonicalUrl: "https://bsky.app/profile/did:plc:alice/post/3knote",
      createdAt: "2026-04-03T10:00:00.000Z",
      updatedAt: "2026-04-03T10:00:00.000Z",
    });

    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3knote",
        rkey: "3knote",
        canonicalRefId: "canonical-note-1",
        operation: "update",
        record: {
          $type: "app.bsky.feed.post",
          text: "Updated note body",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostEdit");
    if (!intent || intent.kind !== "PostEdit") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Update",
        object: expect.objectContaining({
          id: "https://bsky.app/profile/did:plc:alice/post/3knote",
          url: "https://bsky.app/profile/did:plc:alice/post/3knote",
        }),
      }),
    );
  });

  it("projects AT note replies with a stable AP inReplyTo resolved from the parent AT URI", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "canonical-parent-note-1",
      canonicalType: "post",
      did: "did:plc:alice",
      collection: "app.bsky.feed.post",
      rkey: "3kparent",
      atUri: "at://did:plc:alice/app.bsky.feed.post/3kparent",
      canonicalUrl: "https://bsky.app/profile/did:plc:alice/post/3kparent",
      createdAt: "2026-04-03T10:00:00.000Z",
      updatedAt: "2026-04-03T10:00:00.000Z",
    });

    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3kreply",
        rkey: "3kreply",
        operation: "create",
        record: {
          $type: "app.bsky.feed.post",
          text: "Reply body",
          reply: {
            parent: {
              uri: "at://did:plc:alice/app.bsky.feed.post/3kparent",
              cid: "bafy-parent",
            },
            root: {
              uri: "at://did:plc:alice/app.bsky.feed.post/3kparent",
              cid: "bafy-parent",
            },
          },
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Create",
        object: expect.objectContaining({
          inReplyTo: "https://bsky.app/profile/did:plc:alice/post/3kparent",
        }),
      }),
    );
  });
});

  // FEP-7888 / FEP-11dd: context property from reply.root
  describe("FEP-7888 AP context from AT reply.root", () => {
    it("sets context equal to inReplyTo when root === parent (direct reply to root)", async () => {
      const aliasStore = new InMemoryAtAliasStore();
      await aliasStore.put({
        canonicalRefId: "canonical-root-1",
        canonicalType: "post",
        did: "did:plc:alice",
        collection: "app.bsky.feed.post",
        rkey: "3kroot",
        atUri: "at://did:plc:alice/app.bsky.feed.post/3kroot",
        canonicalUrl: "https://bsky.app/profile/did:plc:alice/post/3kroot",
        createdAt: "2026-04-03T10:00:00.000Z",
        updatedAt: "2026-04-03T10:00:00.000Z",
      });

      const { translationContext, projectionContext } = createProtocolBridgeContexts(
        createIdentityRepo() as any,
        aliasStore,
      );
      const translator = new AtprotoToCanonicalTranslator();
      const projector = new CanonicalToActivityPubProjector();

      const intent = await translator.translate(
        {
          repoDid: "did:plc:alice",
          uri: "at://did:plc:alice/app.bsky.feed.post/3kreply-direct",
          rkey: "3kreply-direct",
          operation: "create",
          record: {
            $type: "app.bsky.feed.post",
            text: "Direct reply to thread root",
            reply: {
              root: { uri: "at://did:plc:alice/app.bsky.feed.post/3kroot", cid: "bafy-root" },
              parent: { uri: "at://did:plc:alice/app.bsky.feed.post/3kroot", cid: "bafy-root" },
            },
          },
        },
        translationContext,
      );

      expect(intent?.kind).toBe("PostCreate");
      if (!intent || intent.kind !== "PostCreate") return;

      const projected = await projector.project(intent, projectionContext);
      expect(projected.kind).toBe("success");
      if (projected.kind !== "success") return;

      const obj = projected.commands[0]?.activity?.["object"] as Record<string, unknown>;
      expect(obj).toEqual(
        expect.objectContaining({
          inReplyTo: "https://bsky.app/profile/did:plc:alice/post/3kroot",
          context: "https://bsky.app/profile/did:plc:alice/post/3kroot/context",
          contextHistory: "https://bsky.app/profile/did:plc:alice/post/3kroot/context/history",
        }),
      );
    });

    it("sets context to root's AP URL, distinct from inReplyTo, for nested replies", async () => {
      const aliasStore = new InMemoryAtAliasStore();
      await aliasStore.put({
        canonicalRefId: "canonical-root-2",
        canonicalType: "post",
        did: "did:plc:alice",
        collection: "app.bsky.feed.post",
        rkey: "3kroot2",
        atUri: "at://did:plc:alice/app.bsky.feed.post/3kroot2",
        canonicalUrl: "https://bsky.app/profile/did:plc:alice/post/3kroot2",
        createdAt: "2026-04-03T10:00:00.000Z",
        updatedAt: "2026-04-03T10:00:00.000Z",
      });
      await aliasStore.put({
        canonicalRefId: "canonical-mid-2",
        canonicalType: "post",
        did: "did:plc:bob",
        collection: "app.bsky.feed.post",
        rkey: "3kmid2",
        atUri: "at://did:plc:bob/app.bsky.feed.post/3kmid2",
        canonicalUrl: "https://bsky.app/profile/did:plc:bob/post/3kmid2",
        createdAt: "2026-04-03T10:01:00.000Z",
        updatedAt: "2026-04-03T10:01:00.000Z",
      });

      const { translationContext, projectionContext } = createProtocolBridgeContexts(
        createIdentityRepo() as any,
        aliasStore,
      );
      const translator = new AtprotoToCanonicalTranslator();
      const projector = new CanonicalToActivityPubProjector();

      const intent = await translator.translate(
        {
          repoDid: "did:plc:alice",
          uri: "at://did:plc:alice/app.bsky.feed.post/3kdeep",
          rkey: "3kdeep",
          operation: "create",
          record: {
            $type: "app.bsky.feed.post",
            text: "Nested reply — parent differs from root",
            reply: {
              root:   { uri: "at://did:plc:alice/app.bsky.feed.post/3kroot2",  cid: "bafy-root2" },
              parent: { uri: "at://did:plc:bob/app.bsky.feed.post/3kmid2",    cid: "bafy-mid2" },
            },
          },
        },
        translationContext,
      );

      expect(intent?.kind).toBe("PostCreate");
      if (!intent || intent.kind !== "PostCreate") return;

      const projected = await projector.project(intent, projectionContext);
      expect(projected.kind).toBe("success");
      if (projected.kind !== "success") return;

      const obj = projected.commands[0]?.activity?.["object"] as Record<string, unknown>;
      expect(obj).toEqual(
        expect.objectContaining({
          inReplyTo: "https://bsky.app/profile/did:plc:bob/post/3kmid2",
          context: "https://bsky.app/profile/did:plc:alice/post/3kroot2/context",
          contextHistory: "https://bsky.app/profile/did:plc:alice/post/3kroot2/context/history",
        }),
      );
    });

    it("projects root (non-reply) AT post with collection-backed context and contextHistory", async () => {
      const aliasStore = new InMemoryAtAliasStore();
      const { translationContext, projectionContext } = createProtocolBridgeContexts(
        createIdentityRepo() as any,
        aliasStore,
      );
      const translator = new AtprotoToCanonicalTranslator();
      const projector = new CanonicalToActivityPubProjector();

      const intent = await translator.translate(
        {
          repoDid: "did:plc:alice",
          uri: "at://did:plc:alice/app.bsky.feed.post/3kstandalone",
          rkey: "3kstandalone",
          operation: "create",
          record: {
            $type: "app.bsky.feed.post",
            text: "Standalone post — no reply chain",
          },
        },
        translationContext,
      );

      expect(intent?.kind).toBe("PostCreate");
      if (!intent || intent.kind !== "PostCreate") return;

      const projected = await projector.project(intent, projectionContext);
      expect(projected.kind).toBe("success");
      if (projected.kind !== "success") return;

      const obj = projected.commands[0]?.activity?.["object"] as Record<string, unknown>;
      expect(obj).toEqual(
        expect.objectContaining({
          context: "https://bsky.app/profile/did:plc:alice/post/3kstandalone/context",
          contextHistory: "https://bsky.app/profile/did:plc:alice/post/3kstandalone/context/history",
        }),
      );
    });
  });
