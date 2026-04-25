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

describe("AP-side longform article parity", () => {
  it("projects AT article updates to the same AP object id when record.url is absent", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "canonical-article-1",
      canonicalType: "article",
      did: "did:plc:alice",
      collection: "site.standard.document",
      rkey: "3karticle",
      atUri: "at://did:plc:alice/site.standard.document/3karticle",
      canonicalUrl: "https://example.com/articles/bridge",
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
        uri: "at://did:plc:alice/site.standard.document/3karticle",
        rkey: "3karticle",
        canonicalRefId: "canonical-article-1",
        operation: "update",
        record: {
          $type: "site.standard.document",
          title: "Bridge article",
          text: "Updated article body",
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
          id: "https://example.com/articles/bridge",
          url: "https://example.com/articles/bridge",
        }),
      }),
    );
  });

  it("projects AT article deletes to the same AP object id when only the alias retains the URL", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "canonical-article-1",
      canonicalType: "article",
      did: "did:plc:alice",
      collection: "site.standard.document",
      rkey: "3karticle",
      atUri: "at://did:plc:alice/site.standard.document/3karticle",
      canonicalUrl: "https://example.com/articles/bridge",
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
        uri: "at://did:plc:alice/site.standard.document/3karticle",
        rkey: "3karticle",
        canonicalRefId: "canonical-article-1",
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
        object: "https://example.com/articles/bridge",
      }),
    );
  });
});
