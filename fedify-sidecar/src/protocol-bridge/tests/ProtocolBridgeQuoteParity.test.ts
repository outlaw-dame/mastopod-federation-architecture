import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { createProtocolBridgeContexts } from "../runtime/createProtocolBridgeContexts.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
import { AtprotoWriteGatewayPort } from "../adapters/AtprotoWriteGatewayPort.js";
import { fetchOpenGraph } from "../../utils/opengraph.js";

vi.mock("../../utils/opengraph.js", () => ({
  fetchOpenGraph: vi.fn(),
}));

const mockedFetchOpenGraph = fetchOpenGraph as unknown as ReturnType<typeof vi.fn>;

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

describe("quote-post parity", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
  });

  it("translates AT quoted-record embeds to canonical quoteOf and projects them to AP quoteUrl", async () => {
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
        uri: "at://did:plc:alice/app.bsky.feed.post/3kquote",
        rkey: "3kquote",
        operation: "create",
        record: {
          $type: "app.bsky.feed.post",
          text: "Quoted post",
          embed: {
            $type: "app.bsky.embed.record",
            record: {
              uri: "at://did:plc:bob/app.bsky.feed.post/3kbase",
              cid: "bafy-quoted-base",
            },
          },
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;
    expect(intent.quoteOf?.atUri).toBe("at://did:plc:bob/app.bsky.feed.post/3kbase");

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Create",
        object: expect.objectContaining({
          quoteUrl: "https://bsky.app/profile/did:plc:bob/post/3kbase",
        }),
      }),
    );
  });

  it("renders AT quote posts with media and link previews on the AP side", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/articles/quoted-link",
      title: "Quoted Link Preview",
      description: "Linked context for the quoted post",
      thumbUrl: "https://cdn.example.com/cards/quoted-link.png",
    });

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
        uri: "at://did:plc:alice/app.bsky.feed.post/3kquotemedia",
        rkey: "3kquotemedia",
        operation: "create",
        record: {
          $type: "app.bsky.feed.post",
          text: "Quote with media and https://example.com/articles/quoted-link",
          facets: [
            {
              index: { byteStart: 21, byteEnd: 61 },
              features: [
                {
                  $type: "app.bsky.richtext.facet#link",
                  uri: "https://example.com/articles/quoted-link",
                },
              ],
            },
          ],
          embed: {
            $type: "app.bsky.embed.recordWithMedia",
            record: {
              uri: "at://did:plc:bob/app.bsky.feed.post/3kquotedrender",
              cid: "bafy-quoted-render",
            },
            media: {
              $type: "app.bsky.embed.images",
              images: [
                {
                  alt: "Quoted render image",
                  image: {
                    $type: "blob",
                    ref: { $link: "bafy-render-image" },
                    mimeType: "image/jpeg",
                    size: 4096,
                  },
                  aspectRatio: {
                    width: 1600,
                    height: 900,
                  },
                },
              ],
            },
          },
          createdAt: "2026-04-10T10:00:00.000Z",
        },
      },
      {
        ...translationContext,
        resolveBlobUrl: async (did: string, cid: string) => `https://cdn.example.com/${did}/${cid}`,
      },
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
          quoteUrl: "https://bsky.app/profile/did:plc:bob/post/3kquotedrender",
          attachment: expect.arrayContaining([
            expect.objectContaining({
              type: "Image",
              mediaType: "image/jpeg",
              url: [
                "https://cdn.example.com/did:plc:alice/bafy-render-image",
                "ipfs://bafy-render-image",
              ],
              name: "Quoted render image",
              width: 1600,
              height: 900,
            }),
            expect.objectContaining({
              type: "Link",
              mediaType: "text/html",
              href: "https://example.com/articles/quoted-link",
              name: "Quoted Link Preview",
              summary: "Linked context for the quoted post",
              preview: expect.objectContaining({
                type: "Article",
                name: "Quoted Link Preview",
                summary: "Linked context for the quoted post",
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("translates AP quoteUrl into canonical quoteOf and projects it to AT embed.record", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "https://remote.example/notes/quoted-1",
      canonicalType: "post",
      did: "did:plc:bob",
      collection: "app.bsky.feed.post",
      rkey: "3kbase",
      atUri: "at://did:plc:bob/app.bsky.feed.post/3kbase",
      cid: "bafy-quoted-base",
      canonicalUrl: "https://bsky.app/profile/did:plc:bob/post/3kbase",
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:00.000Z",
    });

    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/quote-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/quote-1",
          type: "Note",
          content: "<p>Replying with a quote</p>",
          quoteUrl: "https://remote.example/notes/quoted-1",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;
    expect(intent.quoteOf?.canonicalObjectId).toBe("https://remote.example/notes/quoted-1");

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    const postCommand = projected.commands.find((command) => command.collection === "app.bsky.feed.post");
    expect(postCommand?.record).toEqual(
      expect.objectContaining({
        embed: expect.objectContaining({
          $type: "app.bsky.embed.record",
          record: {
            uri: "at://did:plc:bob/app.bsky.feed.post/3kbase",
            cid: "bafy-quoted-base",
          },
        }),
      }),
    );
  });

  it("projects AP quote plus image attachment to AT embed.recordWithMedia", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "https://remote.example/notes/quoted-2",
      canonicalType: "post",
      did: "did:plc:bob",
      collection: "app.bsky.feed.post",
      rkey: "3kquotedmedia",
      atUri: "at://did:plc:bob/app.bsky.feed.post/3kquotedmedia",
      cid: "bafy-quoted-media",
      canonicalUrl: "https://bsky.app/profile/did:plc:bob/post/3kquotedmedia",
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:00.000Z",
    });

    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/quote-media-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/quote-media-1",
          type: "Note",
          content: "<p>Quote with media</p>",
          quoteUrl: "https://remote.example/notes/quoted-2",
          attachment: [
            {
              type: "Image",
              mediaType: "image/png",
              url: "https://cdn.example.com/media/quote-image.png",
              cid: "bafy-local-image",
              byteSize: 2048,
              name: "Quoted image alt",
              width: 1280,
              height: 720,
            },
          ],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    const postCommand = projected.commands.find((command) => command.collection === "app.bsky.feed.post");
    expect(postCommand?.record).toEqual(
      expect.objectContaining({
        embed: expect.objectContaining({
          $type: "app.bsky.embed.recordWithMedia",
          record: {
            uri: "at://did:plc:bob/app.bsky.feed.post/3kquotedmedia",
            cid: "bafy-quoted-media",
          },
          media: expect.objectContaining({
            $type: "app.bsky.embed.images",
            images: [
              expect.objectContaining({
                alt: "Quoted image alt",
                image: expect.objectContaining({
                  $type: "blob",
                  ref: { $link: "bafy-local-image" },
                  mimeType: "image/png",
                  size: 2048,
                }),
                aspectRatio: {
                  width: 1280,
                  height: 720,
                },
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("projects AP quote posts with media while warning that AT link previews cannot coexist with quote embeds", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/articles/quote-link",
      title: "Quote Link Preview",
      description: "Preview that must yield to the quote embed on AT",
      thumbUrl: "https://cdn.example.com/cards/quote-link.png",
    });

    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "https://remote.example/notes/quoted-3",
      canonicalType: "post",
      did: "did:plc:bob",
      collection: "app.bsky.feed.post",
      rkey: "3kquotedlink",
      atUri: "at://did:plc:bob/app.bsky.feed.post/3kquotedlink",
      cid: "bafy-quoted-link",
      canonicalUrl: "https://bsky.app/profile/did:plc:bob/post/3kquotedlink",
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:00.000Z",
    });

    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/quote-media-link-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/quote-media-link-1",
          type: "Note",
          content: "<p>Quote with media and https://example.com/articles/quote-link</p>",
          quoteUrl: "https://remote.example/notes/quoted-3",
          attachment: [
            {
              type: "Image",
              mediaType: "image/png",
              url: "https://cdn.example.com/media/quote-link-image.png",
              cid: "bafy-quote-link-image",
              byteSize: 8192,
              name: "Quote link image alt",
              width: 1200,
              height: 800,
            },
          ],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AT_LINK_PREVIEW_SKIPPED_WITH_QUOTE",
        }),
      ]),
    );

    const postCommand = projected.commands.find((command) => command.collection === "app.bsky.feed.post");
    expect(postCommand?.record).toEqual(
      expect.objectContaining({
        embed: expect.objectContaining({
          $type: "app.bsky.embed.recordWithMedia",
          record: {
            uri: "at://did:plc:bob/app.bsky.feed.post/3kquotedlink",
            cid: "bafy-quoted-link",
          },
          media: expect.objectContaining({
            $type: "app.bsky.embed.images",
          }),
        }),
      }),
    );
    expect(postCommand?.linkPreviewThumbUrlHint).toBe("https://cdn.example.com/cards/quote-link.png");
  });

  it("preserves quoted records when URL-backed quote media is resolved during AT write application", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "https://remote.example/notes/quoted-4",
      canonicalType: "post",
      did: "did:plc:bob",
      collection: "app.bsky.feed.post",
      rkey: "3kquotedwrite",
      atUri: "at://did:plc:bob/app.bsky.feed.post/3kquotedwrite",
      cid: "bafy-quoted-write",
      canonicalUrl: "https://bsky.app/profile/did:plc:bob/post/3kquotedwrite",
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:00.000Z",
    });

    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      {
        id: "https://example.com/activities/quote-write-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/quote-write-1",
          type: "Note",
          content: "<p>Quote with resolver-backed media</p>",
          quoteUrl: "https://remote.example/notes/quoted-4",
          attachment: [
            {
              type: "Image",
              mediaType: "image/png",
              url: "https://cdn.example.com/media/resolved-quote-image.png",
              byteSize: 10240,
              name: "Resolver quote image",
              width: 1080,
              height: 1080,
            },
          ],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    const postCommand = projected.commands.find((command) => command.collection === "app.bsky.feed.post");
    expect(postCommand?.record).toEqual(
      expect.objectContaining({
        embed: expect.objectContaining({
          $type: "app.bsky.embed.record",
          record: {
            uri: "at://did:plc:bob/app.bsky.feed.post/3kquotedwrite",
            cid: "bafy-quoted-write",
          },
        }),
      }),
    );
    expect(postCommand?.attachmentMediaHints).toEqual([
      expect.objectContaining({
        url: "https://cdn.example.com/media/resolved-quote-image.png",
        mediaType: "image/png",
      }),
    ]);

    const writeGateway = {
      createRecord: vi.fn().mockResolvedValue({
        uri: "at://did:plc:alice/app.bsky.feed.post/3kresolvedquote",
        cid: "bafy-created-post",
      }),
      putRecord: vi.fn(),
      deleteRecord: vi.fn(),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        atprotoSource: "local",
        atprotoManaged: true,
      }),
    };
    const attachmentMediaResolver = {
      resolveAttachmentBlob: vi.fn().mockResolvedValue({
        $type: "blob",
        ref: { $link: "bafy-uploaded-quote-image" },
        mimeType: "image/png",
        size: 10240,
      }),
    };

    const port = new AtprotoWriteGatewayPort(
      writeGateway as any,
      accountResolver as any,
      { attachmentMediaResolver },
    );

    await port.apply([postCommand!]);

    expect(writeGateway.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: "app.bsky.feed.post",
        record: expect.objectContaining({
          embed: {
            $type: "app.bsky.embed.recordWithMedia",
            record: {
              uri: "at://did:plc:bob/app.bsky.feed.post/3kquotedwrite",
              cid: "bafy-quoted-write",
            },
            media: {
              $type: "app.bsky.embed.images",
              images: [
                expect.objectContaining({
                  alt: "Resolver quote image",
                  image: {
                    $type: "blob",
                    ref: { $link: "bafy-uploaded-quote-image" },
                    mimeType: "image/png",
                    size: 10240,
                  },
                  aspectRatio: {
                    width: 1080,
                    height: 1080,
                  },
                }),
              ],
            },
          },
        }),
      }),
      expect.anything(),
    );
  });
});
