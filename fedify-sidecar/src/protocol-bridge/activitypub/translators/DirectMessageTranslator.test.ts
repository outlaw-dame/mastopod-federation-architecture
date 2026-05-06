/**
 * DirectMessageTranslator — unit + cross-protocol integration tests
 *
 * Covers:
 *   - supports() filtering (single/group recipient DM vs public addressing)
 *   - translate() happy path → CanonicalDirectMessageIntent
 *   - translate() edge cases: missing object, too-long text, null bytes
 *   - E2E AP DM → ActivityPubToCanonicalTranslator pipeline (does not produce
 *     PostCreate intent; produces DirectMessage intent for 1:1 and group DMs)
 */

import { describe, expect, it, vi } from "vitest";
import {
  DirectMessageTranslator,
  translateDirectMessageActivity,
} from "./DirectMessageTranslator.js";
import { ActivityPubToCanonicalTranslator } from "../ActivityPubToCanonicalTranslator.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalActorRef } from "../../canonical/CanonicalActorRef.js";
import type { CanonicalDirectMessageIntent } from "../../canonical/CanonicalIntent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActorRef(activityPubActorUri: string): CanonicalActorRef {
  return {
    activityPubActorUri,
    did: null,
    canonicalAccountId: null,
    webId: null,
    handle: null,
  };
}

function makeCtx(overrides?: Partial<TranslationContext>): TranslationContext {
  return {
    resolveActorRef: vi.fn(async (ref: CanonicalActorRef) =>
      makeActorRef(ref.activityPubActorUri ?? ref.did ?? ref.webId ?? "unknown"),
    ),
    resolveObjectRef: vi.fn(async (ref) => ref),
    ...overrides,
  } as unknown as TranslationContext;
}

const ALICE_URI = "https://alice.example.com/users/alice";
const BOB_URI = "https://bob.example.com/users/bob";
const CAROL_URI = "https://carol.example.com/users/carol";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

function makeDmActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: "https://alice.example.com/activities/1",
    type: "Create",
    actor: ALICE_URI,
    to: BOB_URI,
    object: {
      type: "Note",
      id: "https://alice.example.com/notes/1",
      content: "Hello Bob!",
      attributedTo: ALICE_URI,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: DirectMessageTranslator.supports()
// ---------------------------------------------------------------------------

describe("DirectMessageTranslator.supports()", () => {
  const t = new DirectMessageTranslator();

  it("returns true for a Create{Note} with a single non-public recipient", () => {
    expect(t.supports(makeDmActivity())).toBe(true);
  });

  it("returns false when addressed to the public stream", () => {
    expect(t.supports(makeDmActivity({ to: PUBLIC }))).toBe(false);
  });

  it("returns true for two non-public recipients (group DM)", () => {
    expect(t.supports(makeDmActivity({ to: [BOB_URI, CAROL_URI] }))).toBe(true);
  });

  it("returns false when the 'to' field is absent", () => {
    expect(t.supports(makeDmActivity({ to: undefined }))).toBe(false);
  });

  it("returns false when the activity type is Announce, not Create", () => {
    expect(t.supports({ ...makeDmActivity(), type: "Announce" })).toBe(false);
  });

  it("returns false when the object type is Article, not Note", () => {
    expect(
      t.supports({
        ...makeDmActivity(),
        object: { ...makeDmActivity().object, type: "Article" },
      }),
    ).toBe(false);
  });

  it("returns false for non-object input", () => {
    expect(t.supports(null)).toBe(false);
    expect(t.supports("string")).toBe(false);
    expect(t.supports(42)).toBe(false);
  });

  it("returns false when the activity is missing an id", () => {
    const { id: _id, ...noId } = makeDmActivity() as Record<string, unknown>;
    expect(t.supports(noId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: translateDirectMessageActivity()
// ---------------------------------------------------------------------------

describe("translateDirectMessageActivity()", () => {
  it("produces a CanonicalDirectMessageIntent with correct fields", async () => {
    const ctx = makeCtx();
    const result = await translateDirectMessageActivity(makeDmActivity(), ctx);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("DirectMessage");
    expect(result!.sender.activityPubActorUri).toBe(ALICE_URI);
    expect(result!.recipient.activityPubActorUri).toBe(BOB_URI);
    expect(result!.text).toBe("Hello Bob!");
    expect(result!.messageId).toBe("https://alice.example.com/notes/1");
    expect(result!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Must have all CanonicalIntentBase required fields
    expect(typeof result!.canonicalIntentId).toBe("string");
    expect(result!.sourceProtocol).toBe("activitypub");
    expect(result!.visibility).toBe("direct");
  });

  it("uses the activity id as messageId when the object has no id", async () => {
    const ctx = makeCtx();
    const activity = makeDmActivity();
    delete (activity.object as Record<string, unknown>)["id"];

    const result = await translateDirectMessageActivity(activity, ctx);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("https://alice.example.com/activities/1");
  });

  it("strips null bytes from the message text", async () => {
    const ctx = makeCtx();
    const activity = makeDmActivity({
      object: {
        type: "Note",
        id: "https://alice.example.com/notes/2",
        content: "Hello\x00Bob",
        attributedTo: ALICE_URI,
      },
    });

    const result = await translateDirectMessageActivity(activity, ctx);
    expect(result!.text).toBe("HelloBob");
  });

  it("truncates text exceeding 10 000 characters", async () => {
    const ctx = makeCtx();
    const longText = "a".repeat(15_000);
    const activity = makeDmActivity({
      object: {
        type: "Note",
        id: "https://alice.example.com/notes/3",
        content: longText,
        attributedTo: ALICE_URI,
      },
    });

    const result = await translateDirectMessageActivity(activity, ctx);
    expect(result!.text.length).toBe(10_000);
  });

  it("returns null when actor refs cannot be resolved", async () => {
    const ctx = makeCtx({
      resolveActorRef: vi.fn(async (_ref: CanonicalActorRef): Promise<CanonicalActorRef> => ({
        activityPubActorUri: null,
        did: null,
        canonicalAccountId: null,
        webId: null,
        handle: null,
      })),
    });

    // resolveActorRef returns an "empty" ref but not null, so message still builds.
    // Test that passing actually-null via monkeypatching returns null:
    const nullCtx: TranslationContext = {
      ...makeCtx(),
      resolveActorRef: async () => null as unknown as CanonicalActorRef,
    };
    const result = await translateDirectMessageActivity(makeDmActivity(), nullCtx);
    expect(result).toBeNull();
  });

  it("produces a group DirectMessage for multi-recipient input", async () => {
    const ctx = makeCtx();
    const result = await translateDirectMessageActivity(
      makeDmActivity({ to: [BOB_URI, CAROL_URI] }),
      ctx,
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("DirectMessage");
    expect(result!.recipient.activityPubActorUri).toBe(BOB_URI);
    expect(result!.additionalRecipients.map((ref) => ref.activityPubActorUri)).toEqual([
      CAROL_URI,
    ]);
  });

  it("returns null for invalid input", async () => {
    const ctx = makeCtx();
    expect(await translateDirectMessageActivity(null, ctx)).toBeNull();
    expect(await translateDirectMessageActivity({}, ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-protocol E2E: AP Create{Note} (DM) → ActivityPubToCanonicalTranslator
// ---------------------------------------------------------------------------

describe("ActivityPubToCanonicalTranslator: DirectMessage routing", () => {
  const registry = new ActivityPubToCanonicalTranslator();

  it("routes a single-recipient Create{Note} to DirectMessage, not PostCreate", async () => {
    const ctx = makeCtx();
    const activity = makeDmActivity();

    const result = await registry.translate(activity, ctx);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("DirectMessage");

    const dm = result as CanonicalDirectMessageIntent;
    expect(dm.sender.activityPubActorUri).toBe(ALICE_URI);
    expect(dm.recipient.activityPubActorUri).toBe(BOB_URI);
    expect(dm.text).toBe("Hello Bob!");
  });

  it("routes a public Create{Note} to PostCreate, not DirectMessage", async () => {
    const ctx = makeCtx();
    const activity = {
      id: "https://alice.example.com/activities/pub1",
      type: "Create",
      actor: ALICE_URI,
      to: PUBLIC,
      object: {
        type: "Note",
        id: "https://alice.example.com/notes/public1",
        content: "Hello world!",
        attributedTo: ALICE_URI,
      },
    };

    const result = await registry.translate(activity, ctx);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("PostCreate");
  });

  it("routes a multi-recipient private Create{Note} to DirectMessage", async () => {
    const ctx = makeCtx();
    const activity = makeDmActivity({ to: [BOB_URI, CAROL_URI] });

    const result = await registry.translate(activity, ctx);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("DirectMessage");

    const dm = result as CanonicalDirectMessageIntent;
    expect(dm.recipient.activityPubActorUri).toBe(BOB_URI);
    expect(dm.additionalRecipients.map((ref) => ref.activityPubActorUri)).toEqual([
      CAROL_URI,
    ]);
  });
});
