import { describe, expect, it, vi } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
import { deriveArticleTeaserRkey } from "../projectors/atproto/post-shared.js";

const NOTE_AP_URI = "https://example.com/notes/1";
const NOTE_AT_URI = "at://did:plc:alice/app.bsky.feed.post/3kpost";
const ARTICLE_AP_URI = "https://example.com/articles/1";
const ARTICLE_AT_URI = "at://did:plc:alice/site.standard.document/3karticle";
const ARTICLE_TEASER_AT_URI = "at://did:plc:alice/app.bsky.feed.post/3kteaser";

const translationContext: TranslationContext = {
  now: () => new Date("2026-04-03T10:00:00.000Z"),
  resolveActorRef: async (ref: CanonicalActorRef) => ({
    canonicalAccountId: ref.canonicalAccountId ?? "acct:alice",
    did: ref.did ?? "did:plc:alice",
    activityPubActorUri: ref.activityPubActorUri ?? "https://example.com/users/alice",
    handle: ref.handle ?? "alice.example.com",
    webId: ref.webId ?? "https://example.com/alice/profile/card#me",
  }),
  resolveObjectRef: async (ref: CanonicalObjectRef) => {
    if (
      ref.canonicalObjectId === NOTE_AP_URI ||
      ref.activityPubObjectId === NOTE_AP_URI ||
      ref.atUri === NOTE_AT_URI
    ) {
      return {
        canonicalObjectId: NOTE_AP_URI,
        atUri: NOTE_AT_URI,
        cid: "bafy-note-1",
        activityPubObjectId: NOTE_AP_URI,
        canonicalUrl: NOTE_AP_URI,
      };
    }

    if (
      ref.canonicalObjectId === ARTICLE_AP_URI ||
      ref.activityPubObjectId === ARTICLE_AP_URI ||
      ref.atUri === ARTICLE_AT_URI
    ) {
      return {
        canonicalObjectId: ARTICLE_AP_URI,
        atUri: ARTICLE_AT_URI,
        cid: "bafy-article-1",
        activityPubObjectId: ARTICLE_AP_URI,
        canonicalUrl: ARTICLE_AP_URI,
      };
    }

    if (ref.canonicalObjectId === `${ARTICLE_AP_URI}::teaser`) {
      return {
        canonicalObjectId: `${ARTICLE_AP_URI}::teaser`,
        atUri: ARTICLE_TEASER_AT_URI,
        cid: "bafy-teaser-1",
        canonicalUrl: ARTICLE_AP_URI,
      };
    }

    return {
      canonicalObjectId: ref.canonicalObjectId,
      atUri: ref.atUri ?? null,
      cid: ref.cid ?? null,
      activityPubObjectId: ref.activityPubObjectId ?? null,
      canonicalUrl: ref.canonicalUrl ?? null,
    };
  },
  resolveBlobUrl: async (did: string, cid: string) =>
    `https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`,
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

const projectionContextWithoutTeaserAlias: ProjectionContext = {
  ...projectionContext,
  resolveObjectRef: async (ref: CanonicalObjectRef) => {
    if (ref.canonicalObjectId === `${ARTICLE_AP_URI}::teaser`) {
      return {
        canonicalObjectId: `${ARTICLE_AP_URI}::teaser`,
        atUri: null,
        cid: null,
        canonicalUrl: ARTICLE_AP_URI,
      };
    }
    return projectionContext.resolveObjectRef(ref);
  },
};

describe("protocol bridge edit/delete/profile slice", () => {
  it("translates AP Update(Note) to a canonical edit and projects to AT putRecord", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/update-note-1",
        type: "Update",
        actor: "https://example.com/users/alice",
        object: {
          id: NOTE_AP_URI,
          type: "Note",
          updated: "2026-04-03T12:00:00.000Z",
          content: "<p>Edited note body #edit</p>",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostEdit");
    if (!intent || intent.kind !== "PostEdit") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands).toEqual([
      expect.objectContaining({
        kind: "updateRecord",
        collection: "app.bsky.feed.post",
        repoDid: "did:plc:alice",
        rkey: "3kpost",
        canonicalRefIdHint: NOTE_AP_URI,
      }),
    ]);
  });

  it("translates AP Delete(Article) to AT deletes for both the document and teaser", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/delete-article-1",
        type: "Delete",
        actor: "https://example.com/users/alice",
        object: {
          id: ARTICLE_AP_URI,
          type: "Article",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostDelete");
    if (!intent || intent.kind !== "PostDelete") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands.map((command) => `${command.collection}:${command.rkey}`)).toEqual([
      "site.standard.document:3karticle",
      "app.bsky.feed.post:3kteaser",
    ]);
  });

  it("derives the AT article teaser update target when the teaser alias is missing", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/update-article-1",
        type: "Update",
        actor: "https://example.com/users/alice",
        object: {
          id: ARTICLE_AP_URI,
          type: "Article",
          updated: "2026-04-03T12:30:00.000Z",
          name: "Updated article",
          summary: "Updated summary",
          url: ARTICLE_AP_URI,
          content: "<p>Updated article body</p>",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostEdit");
    if (!intent || intent.kind !== "PostEdit") return;

    const projected = await projector.project(intent, projectionContextWithoutTeaserAlias);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands.map((command) => `${command.collection}:${command.rkey}`)).toEqual([
      "site.standard.document:3karticle",
      `app.bsky.feed.post:${deriveArticleTeaserRkey("3karticle")}`,
    ]);
    expect(projected.warnings.some((warning) => warning.code === "AT_ARTICLE_TEASER_UPDATE_SKIPPED")).toBe(false);
  });

  it("derives the AT article teaser delete target when the teaser alias is missing", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/delete-article-fallback-1",
        type: "Delete",
        actor: "https://example.com/users/alice",
        object: {
          id: ARTICLE_AP_URI,
          type: "Article",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostDelete");
    if (!intent || intent.kind !== "PostDelete") return;

    const projected = await projector.project(intent, projectionContextWithoutTeaserAlias);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands.map((command) => `${command.collection}:${command.rkey}`)).toEqual([
      "site.standard.document:3karticle",
      `app.bsky.feed.post:${deriveArticleTeaserRkey("3karticle")}`,
    ]);
    expect(projected.warnings.some((warning) => warning.code === "AT_ARTICLE_TEASER_DELETE_SKIPPED")).toBe(false);
  });

  it("translates AT profile updates to canonical profile intents and AP Update(Person)", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.actor.profile/self",
        rkey: "self",
        operation: "update",
        record: {
          $type: "app.bsky.actor.profile",
          displayName: "Alice Example",
          description: "Bridge profile bio",
          avatar: {
            $type: "blob",
            ref: { $link: "bafy-avatar" },
            mimeType: "image/png",
            size: 1234,
          },
          banner: {
            $type: "blob",
            ref: { $link: "bafy-banner" },
            mimeType: "image/jpeg",
            size: 5678,
          },
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("ProfileUpdate");
    if (!intent || intent.kind !== "ProfileUpdate") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Update",
        actor: "https://example.com/users/alice",
        object: expect.objectContaining({
          type: "Person",
          name: "Alice Example",
          icon: expect.objectContaining({
            type: "Image",
            mediaType: "image/png",
            url: "https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aalice&cid=bafy-avatar",
          }),
          image: expect.objectContaining({
            type: "Image",
            mediaType: "image/jpeg",
            url: "https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aalice&cid=bafy-banner",
          }),
        }),
      }),
    );
  });

  it("projects AP profile avatar and banner into bridged AT profile media descriptors", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/update-profile-media-1",
        type: "Update",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/users/alice",
          type: "Person",
          name: "Alice Example",
          summary: "<p>Updated bio</p>",
          icon: {
            type: "Image",
            url: "https://cdn.example.com/avatar.png",
            mediaType: "image/png",
            width: 256,
            height: 256,
          },
          image: {
            type: "Image",
            url: "https://cdn.example.com/banner.jpg",
            mediaType: "image/jpeg",
            width: 1500,
            height: 500,
          },
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("ProfileUpdate");
    if (!intent || intent.kind !== "ProfileUpdate") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]).toEqual(
      expect.objectContaining({
        kind: "updateRecord",
        collection: "app.bsky.actor.profile",
        record: expect.objectContaining({
          _bridgeProfileMedia: {
            avatar: expect.objectContaining({
              role: "avatar",
              sourceUrl: "https://cdn.example.com/avatar.png",
              mimeType: "image/png",
            }),
            banner: expect.objectContaining({
              role: "banner",
              sourceUrl: "https://cdn.example.com/banner.jpg",
              mimeType: "image/jpeg",
            }),
          },
        }),
      }),
    );
  });

  it("translates AT post delete envelopes to AP Delete activities", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: NOTE_AT_URI,
        rkey: "3kpost",
        collection: "app.bsky.feed.post",
        canonicalRefId: NOTE_AP_URI,
        operation: "delete",
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostDelete");
    if (!intent || intent.kind !== "PostDelete") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Delete",
        object: NOTE_AP_URI,
      }),
    );
  });
});
