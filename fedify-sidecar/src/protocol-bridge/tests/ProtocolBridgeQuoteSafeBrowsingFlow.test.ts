import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { createProtocolBridgeContexts } from "../runtime/createProtocolBridgeContexts.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("undici", () => ({
  request: requestMock,
}));

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

describe("quote + Safe Browsing integration flow", () => {
  beforeEach(() => {
    requestMock.mockReset();
    process.env["GOOGLE_SAFE_BROWSING_API_KEY"] = "test-api-key";
    delete process.env["SAFE_BROWSING_API_KEY"];
    delete process.env["SAFE_BROWSING_FAIL_CLOSED"];
  });

  afterEach(() => {
    delete process.env["GOOGLE_SAFE_BROWSING_API_KEY"];
    delete process.env["SAFE_BROWSING_API_KEY"];
    delete process.env["SAFE_BROWSING_FAIL_CLOSED"];
  });

  it("projects quote posts while suppressing link preview when Safe Browsing flags the URL", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        text: async () => JSON.stringify({ threats: [{ threatType: "MALWARE" }] }),
      },
    });

    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "https://remote.example/posts/quoted-safe",
      canonicalType: "post",
      did: "did:plc:bob",
      collection: "app.bsky.feed.post",
      rkey: "3kquoted-safe",
      atUri: "at://did:plc:bob/app.bsky.feed.post/3kquoted-safe",
      cid: "bafy-quoted-safe",
      canonicalUrl: "https://bsky.app/profile/did:plc:bob/post/3kquoted-safe",
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
        id: "https://example.com/activities/quote-safe-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/quote-safe-1",
          type: "Note",
          content: "<p>Quoted note with suspicious link https://malware.example/phish</p>",
          quoteUrl: "https://remote.example/posts/quoted-safe",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    // Safe Browsing suppresses the preview, but quote relation remains.
    expect(intent.quoteOf?.canonicalObjectId).toBe("https://remote.example/posts/quoted-safe");
    expect(intent.content.linkPreview).toBeNull();

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    const postCommand = projected.commands.find((command) => command.collection === "app.bsky.feed.post");
    expect(postCommand?.record).toEqual(
      expect.objectContaining({
        embed: expect.objectContaining({
          $type: "app.bsky.embed.record",
          record: {
            uri: "at://did:plc:bob/app.bsky.feed.post/3kquoted-safe",
            cid: "bafy-quoted-safe",
          },
        }),
      }),
    );

    // Only Safe Browsing request should be made; no OpenGraph page fetch.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]?.[0]).toContain("safebrowsing.googleapis.com");
  });
});
