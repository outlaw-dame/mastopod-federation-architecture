/**
 * Interaction policy round-trip tests.
 *
 * Covers the full lifecycle of `CanonicalInteractionPolicy`:
 *   AP → canonical        (parsing `interactionPolicy` from Note objects)
 *   canonical → AP        (projecting policy to `interactionPolicy` on published Notes)
 *   canonical → AT        (projecting policy to threadgate / postgate companion records)
 *   AT gate → canonical   (BskyThreadgateTranslator / BskyPostgateTranslator)
 *   canonical (policy update) → AP  (PostInteractionPolicyUpdateToApProjector)
 *   canonical (policy update) → AT  (PostInteractionPolicyUpdateToAtProjector)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { createProtocolBridgeContexts } from "../runtime/createProtocolBridgeContexts.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
import { PostInteractionPolicyUpdateToApProjector } from "../projectors/activitypub/PostInteractionPolicyUpdateToApProjector.js";
import { PostInteractionPolicyUpdateToAtProjector } from "../projectors/atproto/PostInteractionPolicyUpdateToAtProjector.js";
import { fetchOpenGraph } from "../../utils/opengraph.js";

vi.mock("../../utils/opengraph.js", () => ({
  fetchOpenGraph: vi.fn(),
}));

const mockedFetchOpenGraph = fetchOpenGraph as unknown as ReturnType<typeof vi.fn>;

const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";

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
    getByCanonicalAccountId: async (id: string) =>
      id === binding.canonicalAccountId ? binding : null,
    getByAtprotoDid: async (did: string) =>
      did === binding.atprotoDid ? binding : null,
    getByActivityPubActorUri: async (uri: string) =>
      uri === binding.activityPubActorUri ? binding : null,
    getByWebId: async (webId: string) =>
      webId === binding.webId ? binding : null,
    getByAtprotoHandle: async (handle: string) =>
      handle === binding.atprotoHandle ? binding : null,
  };
}

/** Construct a minimal Create(Note) activity with an optional interactionPolicy. */
function makeCreateNote(
  interactionPolicy?: Record<string, unknown>,
): Record<string, unknown> {
  const object: Record<string, unknown> = {
    id: "https://example.com/notes/1",
    type: "Note",
    attributedTo: "https://example.com/users/alice",
    content: "<p>Hello</p>",
    published: "2024-01-01T00:00:00Z",
    to: [PUBLIC_AUDIENCE],
    cc: [],
  };

  if (interactionPolicy !== undefined) {
    object["interactionPolicy"] = interactionPolicy;
  }

  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://example.com/notes/1#create",
    type: "Create",
    actor: "https://example.com/users/alice",
    object,
    published: "2024-01-01T00:00:00Z",
    to: [PUBLIC_AUDIENCE],
    cc: [],
  };
}

// ---------------------------------------------------------------------------
// AP → canonical parsing
// ---------------------------------------------------------------------------

describe("AP → canonical: interactionPolicy parsing", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
  });

  it("returns null interactionPolicy when no interactionPolicy is present (defaults apply)", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();

    const intent = await translator.translate(makeCreateNote(), translationContext);
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    // Absent policy → null (callers treat null as all-default).
    expect(intent.interactionPolicy).toBeNull();
  });

  it("returns null when interactionPolicy advertises all-default (everyone/everyone)", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();

    const intent = await translator.translate(
      makeCreateNote({
        canReply: { automaticApproval: PUBLIC_AUDIENCE },
        canQuote: { automaticApproval: PUBLIC_AUDIENCE },
      }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    // Both fields are default → null (no non-default policy to carry).
    expect(intent.interactionPolicy).toBeNull();
  });

  it("parses canReply:followers (followers URI) from AP", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();

    const intent = await translator.translate(
      makeCreateNote({
        canReply: { automaticApproval: "https://example.com/users/alice/followers" },
        canQuote: { automaticApproval: PUBLIC_AUDIENCE },
      }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    expect(intent.interactionPolicy?.canReply).toBe("followers");
    expect(intent.interactionPolicy?.canQuote).toBe("everyone");
  });

  it("parses canReply:nobody from an empty canReply object", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();

    const intent = await translator.translate(
      makeCreateNote({
        canReply: {},
        canQuote: { automaticApproval: PUBLIC_AUDIENCE },
      }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    expect(intent.interactionPolicy?.canReply).toBe("nobody");
    expect(intent.interactionPolicy?.canQuote).toBe("everyone");
  });

  it("parses canQuote:nobody from an empty canQuote object", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();

    const intent = await translator.translate(
      makeCreateNote({
        canReply: { automaticApproval: PUBLIC_AUDIENCE },
        canQuote: {},
      }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    expect(intent.interactionPolicy?.canReply).toBe("everyone");
    expect(intent.interactionPolicy?.canQuote).toBe("nobody");
  });

  it("parses both canReply:nobody and canQuote:nobody (locked-down post)", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();

    const intent = await translator.translate(
      makeCreateNote({ canReply: {}, canQuote: {} }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    expect(intent.interactionPolicy?.canReply).toBe("nobody");
    expect(intent.interactionPolicy?.canQuote).toBe("nobody");
  });
});

// ---------------------------------------------------------------------------
// canonical → AP projection
// ---------------------------------------------------------------------------

describe("canonical → AP: interactionPolicy projection", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
  });

  it("projects no interactionPolicy (null) as everyone/everyone on AP", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(makeCreateNote(), translationContext);
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const object = (result.commands[0] as any)?.activity?.object as Record<string, unknown>;
    expect(object?.["interactionPolicy"]).toEqual({
      canReply: { automaticApproval: PUBLIC_AUDIENCE },
      canQuote: { automaticApproval: PUBLIC_AUDIENCE },
    });
  });

  it("projects canReply:followers to AP followers URI", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      makeCreateNote({
        canReply: { automaticApproval: "https://example.com/users/alice/followers" },
        canQuote: { automaticApproval: PUBLIC_AUDIENCE },
      }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;
    expect(intent.interactionPolicy?.canReply).toBe("followers");

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const object = (result.commands[0] as any)?.activity?.object as Record<string, unknown>;
    const policy = object?.["interactionPolicy"] as Record<string, unknown>;
    expect((policy?.["canReply"] as any)?.["automaticApproval"]).toBe(
      "https://example.com/users/alice/followers",
    );
  });

  it("projects canReply:nobody as empty canReply object on AP", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      makeCreateNote({ canReply: {}, canQuote: {} }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const object = (result.commands[0] as any)?.activity?.object as Record<string, unknown>;
    const policy = object?.["interactionPolicy"] as Record<string, unknown>;
    // Both "nobody" → empty objects (no automaticApproval, no manualApproval).
    expect(policy?.["canReply"]).toEqual({});
    expect(policy?.["canQuote"]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// canonical → AT: gate record emission
// ---------------------------------------------------------------------------

describe("canonical → AT: gate record emission", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
  });

  it("emits no gate records when interactionPolicy is null (defaults)", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(makeCreateNote(), translationContext);
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const collections = result.commands.map((c) => c.collection);
    expect(collections).not.toContain("app.bsky.feed.threadgate");
    expect(collections).not.toContain("app.bsky.feed.postgate");
    // Only the post record.
    expect(collections).toContain("app.bsky.feed.post");
  });

  it("emits a threadgate record for canReply:nobody", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      makeCreateNote({ canReply: {}, canQuote: { automaticApproval: PUBLIC_AUDIENCE } }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const gateCmd = result.commands.find((c) => c.collection === "app.bsky.feed.threadgate");
    expect(gateCmd).toBeDefined();
    expect((gateCmd?.record as any)?.$type).toBe("app.bsky.feed.threadgate");
    expect((gateCmd?.record as any)?.allow).toEqual([]);

    // Gate rkey must equal the post rkey.
    const postCmd = result.commands.find((c) => c.collection === "app.bsky.feed.post");
    expect(gateCmd?.rkey).toBe(postCmd?.rkey);
  });

  it("emits a threadgate record for canReply:followers with followingRule", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      makeCreateNote({
        canReply: { automaticApproval: "https://example.com/users/alice/followers" },
        canQuote: { automaticApproval: PUBLIC_AUDIENCE },
      }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const gateCmd = result.commands.find((c) => c.collection === "app.bsky.feed.threadgate");
    expect(gateCmd).toBeDefined();
    expect((gateCmd?.record as any)?.allow).toEqual([
      { $type: "app.bsky.feed.threadgate#followingRule" },
    ]);
    // Gate rkey must equal the post rkey.
    const postCmd = result.commands.find((c) => c.collection === "app.bsky.feed.post");
    expect(gateCmd?.rkey).toBe(postCmd?.rkey);
  });

  it("emits a postgate record for canQuote:nobody with disableRule", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      makeCreateNote({
        canReply: { automaticApproval: PUBLIC_AUDIENCE },
        canQuote: {},
      }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const gateCmd = result.commands.find((c) => c.collection === "app.bsky.feed.postgate");
    expect(gateCmd).toBeDefined();
    expect((gateCmd?.record as any)?.$type).toBe("app.bsky.feed.postgate");
    expect((gateCmd?.record as any)?.embeddingRules).toEqual([
      { $type: "app.bsky.feed.postgate#disableRule" },
    ]);
    // Gate rkey must equal the post rkey.
    const postCmd = result.commands.find((c) => c.collection === "app.bsky.feed.post");
    expect(gateCmd?.rkey).toBe(postCmd?.rkey);
  });

  it("emits both threadgate and postgate for a fully locked-down post", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      makeCreateNote({ canReply: {}, canQuote: {} }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const collections = result.commands.map((c) => c.collection);
    expect(collections).toContain("app.bsky.feed.post");
    expect(collections).toContain("app.bsky.feed.threadgate");
    expect(collections).toContain("app.bsky.feed.postgate");

    const postCmd = result.commands.find((c) => c.collection === "app.bsky.feed.post");
    const threadCmd = result.commands.find((c) => c.collection === "app.bsky.feed.threadgate");
    const pgCmd = result.commands.find((c) => c.collection === "app.bsky.feed.postgate");

    // All three records share the same rkey (AT protocol requirement).
    expect(threadCmd?.rkey).toBe(postCmd?.rkey);
    expect(pgCmd?.rkey).toBe(postCmd?.rkey);

    // threadgate: empty allow (nobody can reply).
    expect((threadCmd?.record as any)?.allow).toEqual([]);
    // postgate: disableRule (nobody can quote).
    expect((pgCmd?.record as any)?.embeddingRules).toEqual([
      { $type: "app.bsky.feed.postgate#disableRule" },
    ]);
  });

  it("gate records point to the post AT URI via the 'post' field", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const intent = await translator.translate(
      makeCreateNote({ canReply: {}, canQuote: {} }),
      translationContext,
    );
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;

    const result = await projector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const postCmd = result.commands.find((c) => c.collection === "app.bsky.feed.post");
    const threadCmd = result.commands.find((c) => c.collection === "app.bsky.feed.threadgate");
    const pgCmd = result.commands.find((c) => c.collection === "app.bsky.feed.postgate");

    const expectedPostAtUri = `at://did:plc:alice/app.bsky.feed.post/${postCmd?.rkey}`;
    expect((threadCmd?.record as any)?.post).toBe(expectedPostAtUri);
    expect((pgCmd?.record as any)?.post).toBe(expectedPostAtUri);
  });
});

// ---------------------------------------------------------------------------
// AT gate records → canonical (BskyThreadgateTranslator / BskyPostgateTranslator)
// ---------------------------------------------------------------------------

function makeThreadgateEnvelope(
  repoDid: string,
  rkey: string,
  allow: unknown[],
  operation: "create" | "update" | "delete" = "create",
): Record<string, unknown> {
  return {
    repoDid,
    uri: `at://${repoDid}/app.bsky.feed.threadgate/${rkey}`,
    rkey,
    operation,
    record: operation !== "delete"
      ? {
          $type: "app.bsky.feed.threadgate",
          post: `at://${repoDid}/app.bsky.feed.post/${rkey}`,
          allow,
          createdAt: "2024-01-01T00:00:00Z",
        }
      : null,
  };
}

function makePostgateEnvelope(
  repoDid: string,
  rkey: string,
  embeddingRules: unknown[],
  operation: "create" | "update" | "delete" = "create",
): Record<string, unknown> {
  return {
    repoDid,
    uri: `at://${repoDid}/app.bsky.feed.postgate/${rkey}`,
    rkey,
    operation,
    record: operation !== "delete"
      ? {
          $type: "app.bsky.feed.postgate",
          post: `at://${repoDid}/app.bsky.feed.post/${rkey}`,
          embeddingRules,
          createdAt: "2024-01-01T00:00:00Z",
        }
      : null,
  };
}

describe("AT gate records → canonical translation", () => {
  it("BskyThreadgateTranslator: followingRule → canReply:followers", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const intent = await translator.translate(
      makeThreadgateEnvelope("did:plc:alice", "abc123", [
        { $type: "app.bsky.feed.threadgate#followingRule" },
      ]),
      translationContext,
    );

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    expect(intent.canReply).toBe("followers");
    // canQuote absent (threadgate only concerns reply policy)
    expect(intent.canQuote).toBeUndefined();
    // object should point to the post, not the gate record
    expect(intent.object.atUri).toBe("at://did:plc:alice/app.bsky.feed.post/abc123");
  });

  it("BskyThreadgateTranslator: mentionRule → canReply:mentioned", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const intent = await translator.translate(
      makeThreadgateEnvelope("did:plc:alice", "abc123", [
        { $type: "app.bsky.feed.threadgate#mentionRule" },
      ]),
      translationContext,
    );

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;
    expect(intent.canReply).toBe("mentioned");
  });

  it("BskyThreadgateTranslator: empty allow → canReply:nobody", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const intent = await translator.translate(
      makeThreadgateEnvelope("did:plc:alice", "abc123", []),
      translationContext,
    );

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;
    expect(intent.canReply).toBe("nobody");
  });

  it("BskyThreadgateTranslator: delete event → canReply:everyone (gate removed)", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const intent = await translator.translate(
      makeThreadgateEnvelope("did:plc:alice", "abc123", [], "delete"),
      translationContext,
    );

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;
    expect(intent.canReply).toBe("everyone");
  });

  it("BskyPostgateTranslator: disableRule → canQuote:nobody", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const intent = await translator.translate(
      makePostgateEnvelope("did:plc:alice", "abc123", [
        { $type: "app.bsky.feed.postgate#disableRule" },
      ]),
      translationContext,
    );

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    expect(intent.canQuote).toBe("nobody");
    // canReply absent (postgate only concerns quote policy)
    expect(intent.canReply).toBeUndefined();
    expect(intent.object.atUri).toBe("at://did:plc:alice/app.bsky.feed.post/abc123");
  });

  it("BskyPostgateTranslator: empty embeddingRules → canQuote:everyone", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const intent = await translator.translate(
      makePostgateEnvelope("did:plc:alice", "abc123", []),
      translationContext,
    );

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;
    expect(intent.canQuote).toBe("everyone");
  });

  it("BskyPostgateTranslator: delete event → canQuote:everyone (gate removed)", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const intent = await translator.translate(
      makePostgateEnvelope("did:plc:alice", "abc123", [], "delete"),
      translationContext,
    );

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;
    expect(intent.canQuote).toBe("everyone");
  });

  it("BskyThreadgateTranslator: accepts firehose ingress envelope format", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const translator = new AtprotoToCanonicalTranslator();

    const ingress = {
      eventType: "#commit",
      did: "did:plc:alice",
      commit: {
        operation: "create",
        collection: "app.bsky.feed.threadgate",
        rkey: "abc123",
        record: {
          $type: "app.bsky.feed.threadgate",
          post: "at://did:plc:alice/app.bsky.feed.post/abc123",
          allow: [{ $type: "app.bsky.feed.threadgate#followingRule" }],
          createdAt: "2024-01-01T00:00:00Z",
        },
      },
    };

    const intent = await translator.translate(ingress, translationContext);

    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;
    expect(intent.canReply).toBe("followers");
    expect(intent.object.atUri).toBe("at://did:plc:alice/app.bsky.feed.post/abc123");
  });
});

// ---------------------------------------------------------------------------
// PostInteractionPolicyUpdate → AP projection
// ---------------------------------------------------------------------------

describe("canonical PostInteractionPolicyUpdate → AP", () => {
  it("emits an AP Update activity with updated interactionPolicy", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const atTranslator = new AtprotoToCanonicalTranslator();
    const apProjector = new PostInteractionPolicyUpdateToApProjector();

    // Produce a PostInteractionPolicyUpdate intent from a threadgate event.
    const intent = await atTranslator.translate(
      makeThreadgateEnvelope("did:plc:alice", "abc123", [
        { $type: "app.bsky.feed.threadgate#followingRule" },
      ]),
      translationContext,
    );
    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    const result = await apProjector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.commands).toHaveLength(1);
    const { activity } = result.commands[0] as any;
    expect(activity.type).toBe("Update");
    expect(activity.actor).toBe("https://example.com/users/alice");

    const object = activity.object as Record<string, unknown>;
    expect(object["type"]).toBe("Note");
    // canReply:followers → automaticApproval = followers URI
    const policy = object["interactionPolicy"] as Record<string, unknown>;
    expect((policy["canReply"] as any)?.automaticApproval).toBe(
      "https://example.com/users/alice/followers",
    );
    // canQuote absent in intent → defaults to "everyone"
    expect((policy["canQuote"] as any)?.automaticApproval).toBe(PUBLIC_AUDIENCE);
  });

  it("emits an empty canReply object when canReply:nobody is updated", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const atTranslator = new AtprotoToCanonicalTranslator();
    const apProjector = new PostInteractionPolicyUpdateToApProjector();

    const intent = await atTranslator.translate(
      makeThreadgateEnvelope("did:plc:alice", "abc123", []),
      translationContext,
    );
    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    const result = await apProjector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const object = (result.commands[0] as any).activity.object as Record<string, unknown>;
    const policy = object["interactionPolicy"] as Record<string, unknown>;
    expect(policy["canReply"]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// PostInteractionPolicyUpdate → AT projection
// ---------------------------------------------------------------------------

describe("canonical PostInteractionPolicyUpdate → AT", () => {
  it("emits createRecord for threadgate when canReply becomes non-default", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const atTranslator = new AtprotoToCanonicalTranslator();
    const atProjector = new PostInteractionPolicyUpdateToAtProjector();

    // Simulate an AP-side threadgate change arriving from the AT firehose.
    // We need an intent with a known post AT URI so the projector can derive
    // the post rkey.  Produce it via the threadgate translator.
    const intent = await atTranslator.translate(
      makeThreadgateEnvelope("did:plc:alice", "testrkey1", [
        { $type: "app.bsky.feed.threadgate#followingRule" },
      ]),
      translationContext,
    );
    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    const result = await atProjector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.commands).toHaveLength(1);
    const cmd = result.commands[0];
    if (!cmd) return;
    expect(cmd.kind).toBe("createRecord");
    expect(cmd.collection).toBe("app.bsky.feed.threadgate");
    expect(cmd.rkey).toBe("testrkey1");
    expect((cmd.record as any)?.allow).toEqual([
      { $type: "app.bsky.feed.threadgate#followingRule" },
    ]);
  });

  it("emits deleteRecord for threadgate when canReply reverts to everyone", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const atTranslator = new AtprotoToCanonicalTranslator();
    const atProjector = new PostInteractionPolicyUpdateToAtProjector();

    const intent = await atTranslator.translate(
      makeThreadgateEnvelope("did:plc:alice", "testrkey2", [], "delete"),
      translationContext,
    );
    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    const result = await atProjector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.commands).toHaveLength(1);
    const cmd = result.commands[0];
    if (!cmd) return;
    expect(cmd.kind).toBe("deleteRecord");
    expect(cmd.collection).toBe("app.bsky.feed.threadgate");
    expect(cmd.rkey).toBe("testrkey2");
  });

  it("emits createRecord for postgate when canQuote becomes nobody", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const atTranslator = new AtprotoToCanonicalTranslator();
    const atProjector = new PostInteractionPolicyUpdateToAtProjector();

    const intent = await atTranslator.translate(
      makePostgateEnvelope("did:plc:alice", "testrkey3", [
        { $type: "app.bsky.feed.postgate#disableRule" },
      ]),
      translationContext,
    );
    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    const result = await atProjector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.commands).toHaveLength(1);
    const cmd = result.commands[0];
    if (!cmd) return;
    expect(cmd.kind).toBe("createRecord");
    expect(cmd.collection).toBe("app.bsky.feed.postgate");
    expect(cmd.rkey).toBe("testrkey3");
    expect((cmd.record as any)?.embeddingRules).toEqual([
      { $type: "app.bsky.feed.postgate#disableRule" },
    ]);
  });

  it("emits deleteRecord for postgate when canQuote reverts to everyone", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const { translationContext, projectionContext } = createProtocolBridgeContexts(
      createIdentityRepo() as any,
      aliasStore,
    );
    const atTranslator = new AtprotoToCanonicalTranslator();
    const atProjector = new PostInteractionPolicyUpdateToAtProjector();

    const intent = await atTranslator.translate(
      makePostgateEnvelope("did:plc:alice", "testrkey4", [], "delete"),
      translationContext,
    );
    expect(intent?.kind).toBe("PostInteractionPolicyUpdate");
    if (!intent || intent.kind !== "PostInteractionPolicyUpdate") return;

    const result = await atProjector.project(intent, projectionContext);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const cmd = result.commands[0];
    if (!cmd) return;
    expect(cmd.kind).toBe("deleteRecord");
    expect(cmd.collection).toBe("app.bsky.feed.postgate");
    expect(cmd.rkey).toBe("testrkey4");
  });
});
