/**
 * Routing Manifest — Parameterized acceptance tests for dual-protocol routing.
 *
 * Architecture invariants under test:
 *   A. Remote public AP  → Stream2 + Firehose (+ AP inbox for user-actor targets)
 *   B. Remote non-public → ActivityPods inbox ONLY, never streams
 *   C. Local public AP   → Stream1 + Firehose (ActivityPods outbox-emitter path)
 *   D. Lifecycle         → Update/Delete/Undo correctly tombstone / update streams
 *   E. Idempotency       → Duplicate delivery produces exactly one record
 *   F. Policy            → Blocked-domain / MRF rejection gates prevent stream writes
 *   G. Isolation         → AT projection failure never poisons AP routing
 *
 * Activity types under test (never hardcoded to Create(Note)):
 *   supportedCreateObjectTypes: Note | Article | Image | Video | Event | Page
 *   supportedActivityTypes:     Create | Announce | Like | Follow | Update | Delete | Undo
 *
 * All tests run fully in-process — no Redis, no RedPanda, no live endpoints.
 * Real dependencies are replaced by the minimal mock stubs below.
 */

// ── Logger mock must come before any module import that depends on it ────────
vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { InboundWorker } from "../inbound-worker.js";

// ── Type imports (adjust paths once bridge / canonical types are extracted) ──
// These types are intentionally defined inline here so the skeleton compiles
// without depending on not-yet-extracted shared type modules.

/** What the test expects to find in canonical.v1 after routing. */
interface CanonicalExpectation {
  published: boolean;
  kind?: string; // e.g. "PostCreate", "FollowAdd", "ReactionAdd"
  isPrivate?: boolean;
}

/** What the test expects to find in Stream1 / Stream2 / Firehose after routing. */
interface StreamExpectation {
  stream1Published: boolean;
  stream2Published: boolean;
  firehoseWritten: boolean; // dual-written atomically with whichever stream
}

/** What the test expects to find at the ActivityPods internal bridge after routing. */
interface InboxExpectation {
  forwarded: boolean;
  targetActorPath?: string; // e.g. "/users/alice" (undefined ⇒ don't assert path)
  rejectedAsSidecarActor?: boolean;
}

/** What the test expects regarding the AT projection call after routing. */
interface ProjectionExpectation {
  attempted: boolean;
  failureIsolated?: boolean; // true ⇒ AP routing must succeed even when AT throws
}

/** Complete per-case assertion surface. */
interface RoutingAssertion {
  canonical: CanonicalExpectation;
  streams: StreamExpectation;
  inbox: InboxExpectation;
  projection: ProjectionExpectation;
}

// ── Parameterisation matrices ────────────────────────────────────────────────

const SUPPORTED_CREATE_OBJECT_TYPES = [
  "Note",
  "Article",
  "Image",
  "Video",
  "Event",
  "Page",
] as const;
type SupportedObjectType = (typeof SUPPORTED_CREATE_OBJECT_TYPES)[number];

const SUPPORTED_ACTIVITY_TYPES = [
  "Create",
  "Announce",
  "Like",
  "Follow",
  "Update",
  "Delete",
  "Undo",
] as const;
type SupportedActivityType = (typeof SUPPORTED_ACTIVITY_TYPES)[number];

// ── Minimal mock stubs ────────────────────────────────────────────────────────

/** Returns a mock RedPandaProducer tracking stream writes. */
function makeRedpanda() {
  return {
    publishToStream1: vi.fn().mockResolvedValue(undefined),
    publishToStream2: vi.fn().mockResolvedValue(undefined),
    publishTombstone: vi.fn().mockResolvedValue(undefined),
    // Firehose is dual-written inside publishToStream1/publishToStream2 atomically;
    // this mock exposes it as a separate spy for assertion clarity.
    _firehoseWrites: [] as string[],
  };
}

/** Returns a mock ActivityPods internal bridge. */
function makeActivityPodsBridge(shouldThrow = false) {
  return {
    forwardInboundActivity: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error("ActivityPods bridge unavailable");
      return { status: 200 };
    }),
  };
}

/** Returns a mock AT projection service. */
function makeAtProjection(shouldThrow = false) {
  return {
    projectToCanonical: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error("AT projection failure");
      return { published: true };
    }),
  };
}

/** Returns a mock canonical event publisher. */
function makeCanonicalPublisher() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

/** Constructs a minimal AP activity JSON payload. */
function makeActivity(
  activityType: SupportedActivityType,
  objectType: SupportedObjectType | null,
  visibility: "public" | "followers" | "direct",
  opts: { actorUri?: string; targetPath?: string } = {},
): Record<string, unknown> {
  const actorUri = opts.actorUri ?? "https://remote.example/users/sender";
  const to =
    visibility === "public"
      ? ["https://www.w3.org/ns/activitystreams#Public"]
      : visibility === "followers"
        ? [`${actorUri}/followers`]
        : [opts.targetPath ?? "https://local.example/users/alice"];

  const base: Record<string, unknown> = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actorUri}/activities/${Math.random().toString(36).slice(2)}`,
    type: activityType,
    actor: actorUri,
    to,
    published: new Date().toISOString(),
  };

  if (objectType !== null) {
    base["object"] = {
      id: `${actorUri}/objects/${Math.random().toString(36).slice(2)}`,
      type: objectType,
      ...(objectType === "Note" || objectType === "Article"
        ? { content: `Test content for ${objectType}` }
        : {}),
    };
  } else if (activityType === "Follow" || activityType === "Undo" || activityType === "Like" || activityType === "Announce") {
    base["object"] = "https://remote.example/users/other";
  }

  return base;
}

// ── Routing harness ───────────────────────────────────────────────────────────

interface TestContext {
  redpanda: ReturnType<typeof makeRedpanda>;
  bridge: ReturnType<typeof makeActivityPodsBridge>;
  atProjection: ReturnType<typeof makeAtProjection>;
  canonical: ReturnType<typeof makeCanonicalPublisher>;
  blockedDomains?: Set<string>;
  _worker?: RoutingTestWorker;
  _seenIds?: Set<string>;
}

/**
 * Minimal subclass of InboundWorker that:
 *  - Skips signature verification (all envelopes are pre-trusted)
 *  - Exposes processEnvelope publicly for direct test invocation
 */
class RoutingTestWorker extends InboundWorker {
  protected override async verifySignature(
    _envelope: import("../../queue/sidecar-redis-queue.js").InboundEnvelope,
  ) {
    return { valid: false, error: "verifySignature should not run in routing tests" };
  }

  /** Expose processEnvelope for direct test invocation. */
  async runEnvelope(
    msgId: string,
    env: import("../../queue/sidecar-redis-queue.js").InboundEnvelope,
  ) {
    return this.processEnvelope(msgId, env);
  }
}

/**
 * Build a minimal pre-trusted InboundEnvelope wrapping the given activity.
 */
function makeEnvelopeFromActivity(
  activity: Record<string, unknown>,
  opts: { path?: string } = {},
): import("../../queue/sidecar-redis-queue.js").InboundEnvelope {
  const actorUri =
    typeof activity["actor"] === "string" ? activity["actor"] : "https://remote.example/users/sender";
  return {
    envelopeId: `test-${Math.random().toString(36).slice(2)}`,
    method: "POST",
    path: opts.path ?? "/users/alice/inbox",
    headers: {
      host: "local.example",
      date: new Date().toUTCString(),
    },
    body: JSON.stringify(activity),
    remoteIp: "127.0.0.1",
    receivedAt: Date.now(),
    attempt: 0,
    notBeforeMs: 0,
    // Pre-trust via Fedify verification so verifySignature is never called
    verification: {
      source: "fedify-v2",
      actorUri,
      verifiedAt: Date.now(),
    },
  };
}

/** Build the minimal queue stub needed for test dispatch. */
function makeNullQueue(opts: { blockedDomains?: Set<string> } = {}) {
  return {
    consumeInbound: async function* () {},
    consumeOutbound: async function* () {},
    enqueueInbound: vi.fn().mockResolvedValue(undefined),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
    moveToDlq: vi.fn().mockResolvedValue(undefined),
    checkIdempotency: vi.fn().mockResolvedValue(true),
    clearIdempotency: vi.fn().mockResolvedValue(undefined),
    isDomainBlocked: vi.fn().mockImplementation(async (domain: string) =>
      opts.blockedDomains ? opts.blockedDomains.has(domain) : false,
    ),
    checkDomainRateLimit: vi.fn().mockResolvedValue(true),
    acquireDomainSlot: vi.fn().mockResolvedValue(true),
    releaseDomainSlot: vi.fn().mockResolvedValue(undefined),
    getClaimIdleTimeMs: () => 60_000,
  } as any;
}

/**
 * Wire InboundWorker with ctx stubs.
 */
function setupFixture(
  _activity: Record<string, unknown>,
  ctx: TestContext,
): void {
  const seenIds = new Set<string>();
  ctx._seenIds = seenIds;
  ctx._worker = new RoutingTestWorker(
    makeNullQueue({ blockedDomains: ctx.blockedDomains }),
    ctx.redpanda as any,
    {
      concurrency: 1,
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "test-token",
      requestTimeoutMs: 5_000,
      userAgent: "test",
      fedifyRuntimeIntegrationEnabled: false,
      sidecarActorPaths: new Set(["/users/relay"]),
      domain: "local.example",
      activityPodsBridge: ctx.bridge,
      atProjection: ctx.atProjection,
      canonicalPublisher: ctx.canonical,
      seenActivityIds: seenIds,
    },
  );
}

/**
 * Dispatch the activity through the routing layer.
 */
async function dispatchEvent(
  activity: Record<string, unknown>,
  ctx: TestContext,
): Promise<void> {
  if (!ctx._worker) {
    setupFixture(activity, ctx);
  }
  const envelope = makeEnvelopeFromActivity(activity);
  await ctx._worker!.runEnvelope("msg-test", envelope);
}


function assertRouting(
  ctx: TestContext,
  expected: RoutingAssertion,
): void {
  // ── Stream assertions ────────────────────────────────────────────────────
  if (expected.streams.stream1Published) {
    expect(ctx.redpanda.publishToStream1).toHaveBeenCalled();
  } else {
    expect(ctx.redpanda.publishToStream1).not.toHaveBeenCalled();
  }

  if (expected.streams.stream2Published) {
    expect(ctx.redpanda.publishToStream2).toHaveBeenCalled();
  } else {
    expect(ctx.redpanda.publishToStream2).not.toHaveBeenCalled();
  }

  // Firehose is written atomically inside publishToStream1 / publishToStream2.
  // Assert the correct stream was called (firehose follows transitively).
  if (!expected.streams.firehoseWritten) {
    expect(ctx.redpanda.publishToStream1).not.toHaveBeenCalled();
    expect(ctx.redpanda.publishToStream2).not.toHaveBeenCalled();
  }

  // ── Inbox assertions ─────────────────────────────────────────────────────
  if (expected.inbox.forwarded) {
    expect(ctx.bridge.forwardInboundActivity).toHaveBeenCalled();
    if (expected.inbox.targetActorPath) {
      expect(ctx.bridge.forwardInboundActivity).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining(expected.inbox.targetActorPath) }),
        expect.anything(),
        expect.anything(),
      );
    }
  } else {
    expect(ctx.bridge.forwardInboundActivity).not.toHaveBeenCalled();
  }

  // ── Canonical assertions ─────────────────────────────────────────────────
  if (expected.canonical.published) {
    expect(ctx.canonical.publish).toHaveBeenCalled();
    if (expected.canonical.kind) {
      expect(ctx.canonical.publish).toHaveBeenCalledWith(
        expect.objectContaining({ kind: expected.canonical.kind }),
      );
    }
    if (expected.canonical.isPrivate !== undefined) {
      expect(ctx.canonical.publish).toHaveBeenCalledWith(
        expect.objectContaining({ isPrivate: expected.canonical.isPrivate }),
      );
    }
  } else {
    expect(ctx.canonical.publish).not.toHaveBeenCalled();
  }

  // ── AT projection assertions ─────────────────────────────────────────────
  if (expected.projection.attempted) {
    expect(ctx.atProjection.projectToCanonical).toHaveBeenCalled();
  }
  // Isolation: if projection.failureIsolated, stream/inbox assertions still
  // pass (checked by the surrounding it.each call succeeding end-to-end).
}

// ── A: Remote public AP → Stream2 + Firehose (+ inbox for user actors) ───────

describe("A: remote public activities reach Stream2 and Firehose", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = {
      redpanda: makeRedpanda(),
      bridge: makeActivityPodsBridge(),
      atProjection: makeAtProjection(),
      canonical: makeCanonicalPublisher(),
    };
  });

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Create(%s) published by a remote actor → Stream2 + Firehose written",
    async (objectType) => {
      const activity = makeActivity("Create", objectType, "public");
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true },
        streams: { stream1Published: false, stream2Published: true, firehoseWritten: true },
        inbox: { forwarded: true, targetActorPath: "/users/" },
        projection: { attempted: true },
      });
    },
  );

  it.each(
    (["Announce", "Like"] as const).flatMap((actType) =>
      SUPPORTED_CREATE_OBJECT_TYPES.map((objType) => [actType, objType] as const),
    ),
  )(
    "%s targeting a %s object → Stream2 + Firehose written",
    async (activityType, objectType) => {
      const activity = makeActivity(activityType, objectType, "public");
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true },
        streams: { stream1Published: false, stream2Published: true, firehoseWritten: true },
        inbox: { forwarded: true },
        projection: { attempted: true },
      });
    },
  );

  it.each(SUPPORTED_ACTIVITY_TYPES)(
    "%s from relay/sidecar actor → Stream2 written, ActivityPods bridge NOT called",
    async (activityType) => {
      const objectType: SupportedObjectType | null =
        activityType === "Follow" || activityType === "Undo" ? null : "Note";
      const activity = makeActivity(activityType, objectType, "public", {
        actorUri: "https://local.example/users/relay",
      });
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true },
        streams: { stream1Published: false, stream2Published: true, firehoseWritten: true },
        inbox: { forwarded: false, rejectedAsSidecarActor: true },
        projection: { attempted: false },
      });
    },
  );
});

// ── B: Remote non-public → ActivityPods inbox ONLY, never streams ─────────────

describe("B: remote non-public activities route to inbox only", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = {
      redpanda: makeRedpanda(),
      bridge: makeActivityPodsBridge(),
      atProjection: makeAtProjection(),
      canonical: makeCanonicalPublisher(),
    };
  });

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Create(%s) with followers-only visibility → inbox forwarded, streams silent",
    async (objectType) => {
      const activity = makeActivity("Create", objectType, "followers");
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true, isPrivate: true },
        streams: { stream1Published: false, stream2Published: false, firehoseWritten: false },
        inbox: { forwarded: true },
        projection: { attempted: false },
      });
    },
  );

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Create(%s) with direct visibility → inbox forwarded, streams silent",
    async (objectType) => {
      const activity = makeActivity("Create", objectType, "direct");
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true, isPrivate: true },
        streams: { stream1Published: false, stream2Published: false, firehoseWritten: false },
        inbox: { forwarded: true },
        projection: { attempted: false },
      });
    },
  );
});

// ── C: Local public AP → Stream1 + Firehose ──────────────────────────────────

describe("C: local public activities reach Stream1 and Firehose", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = {
      redpanda: makeRedpanda(),
      bridge: makeActivityPodsBridge(),
      atProjection: makeAtProjection(),
      canonical: makeCanonicalPublisher(),
    };
  });

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "locally-authored Create(%s) → Stream1 + Firehose written, Stream2 silent",
    async (objectType) => {
      const activity = makeActivity("Create", objectType, "public", {
        actorUri: "https://local.example/users/alice",
      });
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true, isPrivate: false },
        streams: { stream1Published: true, stream2Published: false, firehoseWritten: true },
        inbox: { forwarded: false }, // outbox path, not inbound
        projection: { attempted: true },
      });
    },
  );
});

// ── D: Lifecycle activities (Update / Delete / Undo) ─────────────────────────

describe("D: lifecycle activities correctly update or tombstone streams", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = {
      redpanda: makeRedpanda(),
      bridge: makeActivityPodsBridge(),
      atProjection: makeAtProjection(),
      canonical: makeCanonicalPublisher(),
    };
  });

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Delete targeting a previously-created %s → tombstone published, Stream2 written",
    async (objectType) => {
      const activity = makeActivity("Delete", objectType, "public");
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true, kind: "PostDelete" },
        streams: { stream1Published: false, stream2Published: true, firehoseWritten: true },
        inbox: { forwarded: true },
        projection: { attempted: true },
      });
      // Tombstone must also be published
      expect(ctx.redpanda.publishTombstone).toHaveBeenCalled();
    },
  );

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Update targeting a %s → Stream2 written, no tombstone",
    async (objectType) => {
      const activity = makeActivity("Update", objectType, "public");
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true, kind: "PostEdit" },
        streams: { stream1Published: false, stream2Published: true, firehoseWritten: true },
        inbox: { forwarded: true },
        projection: { attempted: true },
      });
      expect(ctx.redpanda.publishTombstone).not.toHaveBeenCalled();
    },
  );

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Undo(Create(%s)) → tombstone published for the original object",
    async (objectType) => {
      const activity = makeActivity("Undo", objectType, "public");
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: true },
        streams: { stream1Published: false, stream2Published: true, firehoseWritten: true },
        inbox: { forwarded: true },
        projection: { attempted: true },
      });
      expect(ctx.redpanda.publishTombstone).toHaveBeenCalled();
    },
  );
});

// ── E: Idempotency — duplicate delivery ───────────────────────────────────────

describe("E: idempotency — duplicate delivery produces exactly one record", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = {
      redpanda: makeRedpanda(),
      bridge: makeActivityPodsBridge(),
      atProjection: makeAtProjection(),
      canonical: makeCanonicalPublisher(),
    };
  });

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Create(%s) delivered twice → Stream2 written exactly once",
    async (objectType) => {
      const activity = makeActivity("Create", objectType, "public");
      await setupFixture(activity, ctx);
      // First delivery
      await dispatchEvent(activity, ctx);
      // Second delivery (same activity id)
      await dispatchEvent(activity, ctx);
      // Idempotency key must gate the second write
      expect(ctx.redpanda.publishToStream2).toHaveBeenCalledTimes(1);
      expect(ctx.bridge.forwardInboundActivity).toHaveBeenCalledTimes(1);
    },
  );
});

// ── F: Policy — blocked domains / MRF rejection ───────────────────────────────

describe("F: policy gates prevent stream writes for blocked domains", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = {
      redpanda: makeRedpanda(),
      bridge: makeActivityPodsBridge(),
      atProjection: makeAtProjection(),
      canonical: makeCanonicalPublisher(),
      blockedDomains: new Set(["blocked.example", "suspended.example"]),
    };
  });

  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Create(%s) from a blocked domain → rejected before stream write",
    async (objectType) => {
      const activity = makeActivity("Create", objectType, "public", {
        actorUri: "https://blocked.example/users/spammer",
      });
      // TODO: configure ctx with a policy stub that marks blocked.example as rejected
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      // Neither stream nor inbox should receive the activity
      assertRouting(ctx, {
        canonical: { published: false },
        streams: { stream1Published: false, stream2Published: false, firehoseWritten: false },
        inbox: { forwarded: false },
        projection: { attempted: false },
      });
    },
  );

  it.each(SUPPORTED_ACTIVITY_TYPES)(
    "%s from a suspended-domain actor → MRF reject, no stream write",
    async (activityType) => {
      const activity = makeActivity(activityType, "Note", "public", {
        actorUri: "https://suspended.example/users/bad",
      });
      await setupFixture(activity, ctx);
      await dispatchEvent(activity, ctx);
      assertRouting(ctx, {
        canonical: { published: false },
        streams: { stream1Published: false, stream2Published: false, firehoseWritten: false },
        inbox: { forwarded: false },
        projection: { attempted: false },
      });
    },
  );
});

// ── G: Isolation — AT projection failure must not poison AP routing ───────────

describe("G: AT projection failure is isolated from AP routing", () => {
  it.each(SUPPORTED_CREATE_OBJECT_TYPES)(
    "Create(%s) with AT projection throwing → Stream2 + inbox still succeed",
    async (objectType) => {
      const ctx: TestContext = {
        redpanda: makeRedpanda(),
        bridge: makeActivityPodsBridge(),
        atProjection: makeAtProjection(/* shouldThrow */ true),
        canonical: makeCanonicalPublisher(),
      };

      const activity = makeActivity("Create", objectType, "public");
      await setupFixture(activity, ctx);

      // Must not throw even though AT projection throws internally
      await expect(dispatchEvent(activity, ctx)).resolves.not.toThrow();

      assertRouting(ctx, {
        canonical: { published: true },
        streams: { stream1Published: false, stream2Published: true, firehoseWritten: true },
        inbox: { forwarded: true },
        projection: { attempted: true, failureIsolated: true },
      });
    },
  );

  it.each(SUPPORTED_ACTIVITY_TYPES)(
    "%s with ActivityPods bridge throwing → AP-side error propagates, streams unaffected",
    async (activityType) => {
      const ctx: TestContext = {
        redpanda: makeRedpanda(),
        bridge: makeActivityPodsBridge(/* shouldThrow */ true),
        atProjection: makeAtProjection(),
        canonical: makeCanonicalPublisher(),
      };

      const activity = makeActivity(activityType, "Note", "public");
      await setupFixture(activity, ctx);

      // Bridge failure aborts the inbound pipeline before Stream2 publication.
      // The worker handles the failure internally via retry / DLQ logic, so the
      // dispatch entrypoint itself should not throw here.
      await expect(dispatchEvent(activity, ctx)).resolves.not.toThrow();

      assertRouting(ctx, {
        canonical: { published: false },
        streams: { stream1Published: false, stream2Published: false, firehoseWritten: false },
        inbox: { forwarded: true },
        projection: { attempted: false },
      });
    },
  );
});
