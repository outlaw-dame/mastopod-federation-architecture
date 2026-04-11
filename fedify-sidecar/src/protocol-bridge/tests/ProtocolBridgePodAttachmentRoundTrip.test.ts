import { describe, expect, it } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";

const translationContext: TranslationContext = {
  now: () => new Date("2026-04-03T10:00:00.000Z"),
  resolveActorRef: async (ref: CanonicalActorRef) => ({
    canonicalAccountId: ref.canonicalAccountId ?? "acct:alice",
    did: ref.did ?? "did:plc:alice",
    activityPubActorUri: ref.activityPubActorUri ?? "https://example.com/users/alice",
    handle: ref.handle ?? "alice.example.com",
    webId: ref.webId ?? "https://example.com/alice/profile/card#me",
  }),
  resolveObjectRef: async (ref: CanonicalObjectRef) => ({
    canonicalObjectId: ref.canonicalObjectId,
    atUri: ref.atUri ?? null,
    cid: ref.cid ?? null,
    activityPubObjectId: ref.activityPubObjectId ?? null,
    canonicalUrl: ref.canonicalUrl ?? null,
  }),
  resolveBlobUrl: async (did: string, cid: string) => `https://cdn.example.com/${did}/${cid}`,
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("pod-owned attachment bridge round-trip", () => {
  it("preserves enriched FEP-1311 attachment metadata from AP input through AP and AT projections", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/pod-note-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/pod-note-1",
          type: "Note",
          content: "<p>Pod-owned image</p>",
          attachment: [
            {
              type: "Image",
              mediaType: "image/png",
              url: "https://example.com/alice/data/photo-1",
              name: "A pod-owned attachment",
              size: 4096,
              digestMultibase: "uASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8",
              focalPoint: [0.1, -0.25],
              blurHash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
              width: 1200,
              height: 800,
            },
          ],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    expect(intent.content.attachments).toEqual([
      expect.objectContaining({
        mediaType: "image/png",
        url: "https://example.com/alice/data/photo-1",
        alt: "A pod-owned attachment",
        byteSize: 4096,
        digestMultibase: "uASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8",
        focalPoint: [0.1, -0.25],
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        width: 1200,
        height: 800,
      }),
    ]);

    const apProjector = new CanonicalToActivityPubProjector();
    const projectedToAp = await apProjector.project(intent, projectionContext);
    expect(projectedToAp.kind).toBe("success");
    if (projectedToAp.kind !== "success") {
      return;
    }

    const apActivity = projectedToAp.commands[0]?.activity as Record<string, unknown>;
    expect(apActivity["@context"]).toEqual(
      expect.arrayContaining([
        "https://www.w3.org/ns/activitystreams",
        expect.objectContaining({
          digestMultibase: "https://w3id.org/security#digestMultibase",
          focalPoint: expect.objectContaining({
            "@id": "https://joinmastodon.org/ns#focalPoint",
            "@container": "@list",
          }),
          blurhash: "http://joinmastodon.org/ns#blurhash",
        }),
      ]),
    );

    expect((apActivity["object"] as Record<string, unknown>)["attachment"]).toEqual([
      expect.objectContaining({
        type: "Image",
        mediaType: "image/png",
        url: "https://example.com/alice/data/photo-1",
        name: "A pod-owned attachment",
        size: 4096,
        digestMultibase: "uASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8",
        focalPoint: [0.1, -0.25],
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        width: 1200,
        height: 800,
      }),
    ]);

    const atProjector = new CanonicalToAtprotoProjector();
    const projectedToAt = await atProjector.project(intent, projectionContext);
    expect(projectedToAt.kind).toBe("success");
    if (projectedToAt.kind !== "success") {
      return;
    }

    expect(projectedToAt.commands[0]?.attachmentMediaHints).toEqual([
      expect.objectContaining({
        mediaType: "image/png",
        url: "https://example.com/alice/data/photo-1",
        byteSize: 4096,
        digestMultibase: "uASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8",
        focalPoint: [0.1, -0.25],
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        width: 1200,
        height: 800,
      }),
    ]);
  });
});
