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
