import { describe, expect, it } from "vitest";
import { serializeCanonicalIntent } from "../canonical/CanonicalIntentPublisher.js";
import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import type { CanonicalIntentBase } from "../canonical/CanonicalEnvelope.js";

const BASE_TIME = "2026-04-25T12:00:00.000Z";

describe("CanonicalIntentPublisher serialization", () => {
  it("serializes visibility and bounded trend candidate content for post intents", () => {
    const intent: CanonicalIntent = {
      ...baseIntent("PostCreate"),
      object: {
        canonicalObjectId: "post-1",
        activityPubObjectId: "https://example.com/notes/1",
        atUri: "at://did:plc:alice/app.bsky.feed.post/abc",
        canonicalUrl: "https://example.com/notes/1",
      },
      content: {
        kind: "note",
        title: null,
        summary: null,
        plaintext: `${"x".repeat(1_100)} tail`,
        html: "<p>ignored html</p>",
        language: "en",
        blocks: [],
        facets: [
          { type: "tag", tag: "ActivityPods", start: 0, end: 13 },
          { type: "tag", tag: "#ActivityPods", start: 14, end: 28 },
          { type: "link", url: "https://example.com/story#section", start: 29, end: 54 },
          { type: "link", url: "javascript:alert(1)", start: 55, end: 74 },
          {
            type: "mention",
            label: "@bob",
            target: { activityPubActorUri: "https://remote.example/users/bob" },
            start: 75,
            end: 79,
          },
        ],
        attachments: [],
        externalUrl: "https://example.com/external",
        linkPreview: {
          uri: "https://example.com/story",
          title: "Story",
        },
      },
      warnings: [],
    };
    const event = serializeCanonicalIntent(intent);

    expect(event.visibility).toBe("public");
    expect(event.content).toEqual({
      kind: "note",
      plaintext: "x".repeat(1_000),
      language: "en",
      tags: ["ActivityPods"],
      links: ["https://example.com/story"],
      externalUrl: "https://example.com/external",
      linkPreviewUrl: "https://example.com/story",
    });
    expect(event.mentions).toEqual(["https://remote.example/users/bob"]);
  });

  it("preserves non-public visibility for downstream admissibility checks", () => {
    const intent: CanonicalIntent = {
      ...baseIntent("ReactionAdd"),
      visibility: "direct",
      object: {
        canonicalObjectId: "post-2",
        activityPubObjectId: "https://example.com/notes/2",
      },
      reactionType: "like",
      warnings: [],
    };
    const event = serializeCanonicalIntent(intent);

    expect(event.visibility).toBe("direct");
    expect(event.content).toBeUndefined();
  });

  it("serializes story intents with object refs and sanitized story summaries", () => {
    const intent: CanonicalIntent = {
      ...baseIntent("StoryCreate"),
      sourceProtocol: "atproto",
      sourceEventId: "at://did:plc:alice/org.activitypods.story.slide/3kstory",
      sourceAccountRef: {
        canonicalAccountId: "acct-alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
      },
      object: {
        canonicalObjectId: "story-1",
        atUri: "at://did:plc:alice/org.activitypods.story.slide/3kstory",
      },
      media: {
        kind: "image",
        blob: {
          $type: "blob",
          ref: { $link: "bafkreistoryimagecid0002" },
          mimeType: "image/jpeg",
          size: 4096,
        },
        alt: "Sunset over the water",
      },
      text: "A story caption",
      links: [
        { uri: "https://example.com/story", title: "Story" },
        { uri: "javascript:alert(1)", title: "bad" },
      ],
      facets: [],
      labels: [],
      allowReplies: true,
      langs: ["en"],
      expiresAt: "2026-04-26T12:00:00.000Z",
      warnings: [],
    };

    const event = serializeCanonicalIntent(intent);

    expect(event.kind).toBe("StoryCreate");
    expect(event.object).toEqual({
      canonicalObjectId: "story-1",
      atUri: "at://did:plc:alice/org.activitypods.story.slide/3kstory",
      activityPubObjectId: null,
      canonicalUrl: null,
    });
    expect(event.content).toEqual({
      kind: "story",
      plaintext: "A story caption",
      language: "en",
      links: ["https://example.com/story"],
    });
  });
});

function baseIntent<K extends CanonicalIntent["kind"]>(kind: K): CanonicalIntentBase & { kind: K } {
  return {
    canonicalIntentId: `intent-${kind}`,
    kind,
    sourceProtocol: "activitypub",
    sourceEventId: `https://example.com/activities/${kind}`,
    sourceAccountRef: {
      canonicalAccountId: "acct-alice",
      activityPubActorUri: "https://example.com/users/alice",
      handle: "alice@example.com",
    },
    createdAt: BASE_TIME,
    observedAt: BASE_TIME,
    visibility: "public",
    provenance: {
      originProtocol: "activitypub",
      originEventId: `https://example.com/activities/${kind}`,
      projectionMode: "native",
    },
    warnings: [],
  };
}
