import { describe, expect, it } from "vitest";
import { buildEnvelopeFromAP, buildEnvelopeFromAT } from "./MRFActivityEnvelope.js";

// ---------------------------------------------------------------------------
// buildEnvelopeFromAP
// ---------------------------------------------------------------------------

describe("buildEnvelopeFromAP", () => {
  it("extracts links and domains from HTML content", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/1",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: {
        object: {
          content:
            '<p>Buy now at <a href="https://spam.example/buy">here</a> and <a href="https://also.spam.example/also">also</a></p>',
        },
      },
    });

    expect(envelope.content.urls).toContain("https://spam.example/buy");
    expect(envelope.content.urls).toContain("https://also.spam.example/also");
    expect(envelope.content.domains).toContain("spam.example");
    expect(envelope.content.domains).toContain("also.spam.example");
    expect(envelope.content.domains).toHaveLength(2);
  });

  it("deduplicates domains from repeated URLs to the same host", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/2",
      actorUri: "https://remote.example/users/bob",
      actorDocument: null,
      activity: {
        object: {
          content:
            '<a href="https://evil.example/a">a</a> <a href="https://evil.example/b">b</a>',
        },
      },
    });

    expect(envelope.content.domains).toEqual(["evil.example"]);
  });

  it("extracts hashtags from tag array", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/3",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: {
        object: {
          content: "<p>#Cats and #Dogs</p>",
          tag: [
            { type: "Hashtag", name: "#Cats", href: "https://remote.example/tags/cats" },
            { type: "Hashtag", name: "#Dogs", href: "https://remote.example/tags/dogs" },
            { type: "Mention", name: "@bob", href: "https://remote.example/users/bob" },
          ],
        },
      },
    });

    expect(envelope.content.hashtags).toEqual(["cats", "dogs"]);
  });

  it("counts non-public cc recipients as mentions", () => {
    const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/4",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: {
        cc: [AS_PUBLIC, "https://remote.example/users/bob", "https://remote.example/users/carol"],
        object: { content: "<p>hello</p>" },
      },
    });

    expect(envelope.content.mentionCount).toBe(2);
  });

  it("falls back to contentMap when content is absent", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/5",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: {
        object: {
          contentMap: {
            en: '<a href="https://spam.example/x">x</a>',
            fr: "Autre contenu",
          },
        },
      },
    });

    expect(envelope.content.urls.length).toBeGreaterThan(0);
    expect(envelope.content.domains).toContain("spam.example");
  });

  it("extracts actor signals from actorDocument", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/6",
      actorUri: "https://remote.example/users/alice",
      actorDocument: {
        published: "2026-01-01T00:00:00Z",
        followers: { totalItems: 42 },
        icon: { url: "https://remote.example/avatar.png" },
        summary: "<p>Bio here</p>",
      },
      activity: { object: { content: "<p>hello</p>" } },
    });

    expect(envelope.actor.publishedAtMs).toBe(new Date("2026-01-01T00:00:00Z").getTime());
    expect(envelope.actor.followerCount).toBe(42);
    expect(envelope.actor.hasAvatar).toBe(true);
    expect(envelope.actor.hasBio).toBe(true);
  });

  it("returns null actor signals when actorDocument is null", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/7",
      actorUri: "https://remote.example/users/anon",
      actorDocument: null,
      activity: {},
    });

    expect(envelope.actor.publishedAtMs).toBeNull();
    expect(envelope.actor.followerCount).toBeNull();
    expect(envelope.actor.hasAvatar).toBe(false);
    expect(envelope.actor.hasBio).toBe(false);
  });

  it("extracts originHost from a standard HTTPS actor URI", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/8",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: {},
    });

    expect(envelope.originHost).toBe("remote.example");
  });

  it("extracts originHost from a did:web actorUri", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "at://did:web:remote.example/app.bsky.feed.post/1",
      actorUri: "did:web:remote.example",
      actorDocument: null,
      activity: {},
    });

    expect(envelope.originHost).toBe("remote.example");
  });

  it("produces empty content signals for a bare activity with no object", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/9",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: { type: "Like", object: "https://remote.example/notes/1" },
    });

    expect(envelope.content.text).toBeNull();
    expect(envelope.content.urls).toHaveLength(0);
    expect(envelope.content.domains).toHaveLength(0);
    expect(envelope.content.hashtags).toHaveLength(0);
    expect(envelope.content.mentionCount).toBe(0);
  });

  it("sets protocol to ap and uses provided visibility and requestId", () => {
    const envelope = buildEnvelopeFromAP({
      activityId: "https://remote.example/activities/10",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: {},
      visibility: "followers",
      requestId: "req-test-1",
    });

    expect(envelope.protocol).toBe("ap");
    expect(envelope.visibility).toBe("followers");
    expect(envelope.requestId).toBe("req-test-1");
  });
});

// ---------------------------------------------------------------------------
// buildEnvelopeFromAT
// ---------------------------------------------------------------------------

describe("buildEnvelopeFromAT", () => {
  it("returns null for non-post collections", () => {
    expect(
      buildEnvelopeFromAT({
        did: "did:plc:abc123",
        collection: "app.bsky.actor.profile",
        rkey: "self",
        record: { displayName: "Alice" },
      }),
    ).toBeNull();
  });

  it("extracts text, link facets, tag facets, and mention facets", () => {
    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc123",
      collection: "app.bsky.feed.post",
      rkey: "3kgmn4",
      record: {
        text: "Check https://spam.example and #crypto cc @bob",
        facets: [
          {
            index: { byteStart: 6, byteEnd: 28 },
            features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://spam.example/page" }],
          },
          {
            index: { byteStart: 33, byteEnd: 40 },
            features: [{ $type: "app.bsky.richtext.facet#tag", tag: "crypto" }],
          },
          {
            index: { byteStart: 44, byteEnd: 48 },
            features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:def456" }],
          },
        ],
      },
    });

    expect(envelope).not.toBeNull();
    expect(envelope!.content.text).toBe("Check https://spam.example and #crypto cc @bob");
    expect(envelope!.content.urls).toContain("https://spam.example/page");
    expect(envelope!.content.domains).toContain("spam.example");
    expect(envelope!.content.hashtags).toContain("crypto");
    expect(envelope!.content.mentionCount).toBe(1);
  });

  it("handles a record with no facets", () => {
    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc123",
      collection: "app.bsky.feed.post",
      rkey: "3kgmn5",
      record: { text: "Just a plain post." },
    });

    expect(envelope).not.toBeNull();
    expect(envelope!.content.urls).toHaveLength(0);
    expect(envelope!.content.domains).toHaveLength(0);
    expect(envelope!.content.hashtags).toHaveLength(0);
    expect(envelope!.content.mentionCount).toBe(0);
  });

  it("sets protocol to at, visibility to public, and correct activityId", () => {
    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc123",
      collection: "app.bsky.feed.post",
      rkey: "3kgmn6",
      record: { text: "hi" },
    });

    expect(envelope!.protocol).toBe("at");
    expect(envelope!.visibility).toBe("public");
    expect(envelope!.activityId).toBe("at://did:plc:abc123/app.bsky.feed.post/3kgmn6");
    expect(envelope!.actorId).toBe("did:plc:abc123");
    expect(envelope!.originHost).toBeNull();
  });

  it("uses provided requestId", () => {
    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc123",
      collection: "app.bsky.feed.post",
      rkey: "rkey1",
      record: { text: "test" },
      requestId: "req-at-test",
    });

    expect(envelope!.requestId).toBe("req-at-test");
  });

  it("returns null actor signals (AT actor metadata requires external fetches)", () => {
    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc123",
      collection: "app.bsky.feed.post",
      rkey: "rkey2",
      record: { text: "test" },
    });

    expect(envelope!.actor.publishedAtMs).toBeNull();
    expect(envelope!.actor.followerCount).toBeNull();
    expect(envelope!.actor.hasAvatar).toBe(false);
    expect(envelope!.actor.hasBio).toBe(false);
  });
});
