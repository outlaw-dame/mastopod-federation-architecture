import { describe, expect, it } from "vitest";

import { ACTIVITYPODS_STORY_COLLECTION } from "../../at-adapter/lexicon/ActivityPodsStoryLexicon.js";
import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import { ActivityPodsStoryTranslator } from "../atproto/translators/ActivityPodsStoryTranslator.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import { StoryCreateToAtProjector } from "../projectors/atproto/StoryCreateToAtProjector.js";
import { StoryDeleteToAtProjector } from "../projectors/atproto/StoryDeleteToAtProjector.js";
import type { ProjectionContext } from "../ports/ProtocolBridgePorts.js";

const NOW = "2026-05-08T12:00:00.000Z";
const STORY_URI = `at://did:plc:alice/${ACTIVITYPODS_STORY_COLLECTION}/3kstory`;

const ctx: ProjectionContext = {
  now: () => new Date(NOW),
  buildIntentId: buildCanonicalIntentId,
  resolveActorRef: async (ref) => ({
    ...ref,
    canonicalAccountId: ref.canonicalAccountId ?? "acct:alice",
    did: ref.did ?? "did:plc:alice",
    handle: ref.handle ?? "alice.example.com",
  }),
  resolveObjectRef: async (ref) => ref,
};

describe("canonical story bridge", () => {
  it("translates AT story records into stable canonical StoryCreate intents and projects them back to story records only", async () => {
    const translator = new ActivityPodsStoryTranslator();
    const intent = await translator.translate(storyEnvelope(), ctx);
    const repeated = await translator.translate(storyEnvelope(), ctx);
    const changed = await translator.translate(storyEnvelope({ text: "A changed caption" }), ctx);

    expect(intent).toMatchObject({
      kind: "StoryCreate",
      canonicalIntentId: repeated?.canonicalIntentId,
      sourceProtocol: "atproto",
      sourceEventId: STORY_URI,
      visibility: "unlisted",
      expiresAt: "2026-05-09T12:00:00.000Z",
      object: {
        atUri: STORY_URI,
      },
      media: {
        kind: "image",
        alt: "A canonical story image",
      },
      links: [{ uri: "https://example.com/story", title: "Story" }],
    });
    expect(changed?.canonicalIntentId).not.toBe(intent?.canonicalIntentId);

    const projector = new StoryCreateToAtProjector();
    const projected = await projector.project(intent as Extract<CanonicalIntent, { kind: "StoryCreate" }>, ctx);

    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }
    expect(projected.commands).toHaveLength(1);
    expect(projected.commands[0]).toMatchObject({
      kind: "createRecord",
      collection: ACTIVITYPODS_STORY_COLLECTION,
      repoDid: "did:plc:alice",
      canonicalRefIdHint: STORY_URI,
      record: {
        $type: ACTIVITYPODS_STORY_COLLECTION,
        visibility: "unlisted",
        text: "A story caption",
        media: {
          kind: "image",
          alt: "A canonical story image",
        },
      },
    });
    expect(projected.commands[0]?.collection).not.toBe("app.bsky.feed.post");
  });

  it("translates and projects story deletes through the canonical object ref", async () => {
    const translator = new ActivityPodsStoryTranslator();
    const intent = await translator.translate({
      repoDid: "did:plc:alice",
      uri: STORY_URI,
      operation: "delete",
    }, ctx);

    expect(intent).toMatchObject({
      kind: "StoryDelete",
      sourceProtocol: "atproto",
      object: {
        atUri: STORY_URI,
      },
    });

    const projector = new StoryDeleteToAtProjector();
    const projected = await projector.project(intent as Extract<CanonicalIntent, { kind: "StoryDelete" }>, ctx);

    expect(projected).toMatchObject({
      kind: "success",
      commands: [
        {
          kind: "deleteRecord",
          collection: ACTIVITYPODS_STORY_COLLECTION,
          repoDid: "did:plc:alice",
          rkey: "3kstory",
        },
      ],
    });
  });
});

function storyEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    repoDid: "did:plc:alice",
    uri: STORY_URI,
    cid: "bafkrei-story-record",
    record: {
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt: NOW,
      expiresAt: "2026-05-09T12:00:00.000Z",
      visibility: "unlisted",
      media: {
        kind: "image",
        blob: {
          $type: "blob",
          ref: { $link: "bafkreistoryimagecid0002" },
          mimeType: "image/jpeg",
          size: 4096,
        },
        alt: "A canonical story image",
      },
      text: "A story caption",
      links: [{ uri: "https://example.com/story", title: "Story" }],
      ...overrides,
    },
  };
}
