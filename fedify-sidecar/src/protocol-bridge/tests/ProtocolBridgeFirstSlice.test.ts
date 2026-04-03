import { describe, expect, it, vi } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { InMemoryProjectionLedger } from "../idempotency/ProjectionLedger.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
import { ApToAtProjectionWorker } from "../workers/ApToAtProjectionWorker.js";
import { AtToApProjectionWorker } from "../workers/AtToApProjectionWorker.js";

const translationContext: TranslationContext = {
  now: () => new Date("2026-04-03T10:00:00.000Z"),
  resolveActorRef: async (ref: CanonicalActorRef) => ({
    canonicalAccountId: ref.canonicalAccountId ?? "acct:alice",
    did: ref.did ?? "did:plc:alice",
    activityPubActorUri:
      ref.activityPubActorUri ?? "https://example.com/users/alice",
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
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("protocol bridge first slice", () => {
  it("translates AP Create(Note) to a canonical intent and projects to AT", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/1",
          type: "Note",
          content: "<p>Hello <a href=\"https://example.com\">world</a> #Bridge</p>",
          tag: [{ type: "Hashtag", name: "#Bridge" }],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;
    expect(intent.content.kind).toBe("note");
    expect(intent.content.plaintext).toContain("Hello world #Bridge");

    const projector = new CanonicalToAtprotoProjector();
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands).toHaveLength(1);
    expect(projected.commands[0]?.collection).toBe("app.bsky.feed.post");
    expect(projected.commands[0]?.record?.["text"]).toContain("Hello world");
  });

  it("translates AP Create(Article) to AT longform plus teaser", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/article-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/articles/1",
          type: "Article",
          name: "Longform post",
          summary: "A bridge article",
          url: "https://example.com/articles/1",
          content: "<p>This is the longform body.</p>",
        },
      },
      translationContext,
    );

    const projector = new CanonicalToAtprotoProjector();
    if (!intent || intent.kind !== "PostCreate") return;
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands.map((command) => command.collection)).toEqual([
      "site.standard.document",
      "app.bsky.feed.post",
    ]);
    expect(projected.commands[0]?.canonicalRefIdHint).toBe(intent.object.canonicalObjectId);
    expect(projected.commands[1]?.canonicalRefIdHint).toBe(`${intent.object.canonicalObjectId}::teaser`);
  });

  it("translates AT commit events to canonical and projects to AP ingress", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const intent = await translator.translate(
      {
        seq: 10,
        eventType: "#commit",
        did: "did:plc:alice",
        commit: {
          operation: "create",
          collection: "app.bsky.feed.post",
          rkey: "3k123",
          cid: "bafy-post",
          record: {
            $type: "app.bsky.feed.post",
            text: "Hello AP #bridge",
            facets: [
              {
                index: { byteStart: 9, byteEnd: 16 },
                features: [{ $type: "app.bsky.richtext.facet#tag", tag: "bridge" }],
              },
            ],
          },
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;
    expect(intent.content.facets).toHaveLength(1);

    const projector = new CanonicalToActivityPubProjector();
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    expect(projected.commands[0]?.targetTopic).toBe("ap.atproto-ingress.v1");
    expect(projected.commands[0]?.activity["type"]).toBe("Create");
    expect((projected.commands[0]?.activity["object"] as Record<string, unknown>)["type"]).toBe("Note");
    expect(projected.commands[0]?.activity["cc"]).toEqual([
      "https://example.com/users/alice/followers",
    ]);
  });

  it("translates AT standard documents to canonical articles", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/site.standard.document/3karticle",
        rkey: "3karticle",
        operation: "create",
        record: {
          $type: "site.standard.document",
          title: "Bridge article",
          summary: "Longform summary",
          text: "Longform body",
          url: "https://example.com/articles/bridge",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;
    expect(intent.content.kind).toBe("article");
    expect(intent.content.title).toBe("Bridge article");
    expect(intent.content.externalUrl).toBe("https://example.com/articles/bridge");
  });

  it("uses retry plus ledger loop prevention in AP->AT worker flow", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();
    const ledger = new InMemoryProjectionLedger();
    const writePort = {
      apply: vi
        .fn(async (_commands: unknown[]) => undefined)
        .mockRejectedValueOnce(Object.assign(new Error("temporary timeout"), { code: "ETIMEDOUT" }))
        .mockResolvedValue(undefined),
    };
    const policy = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const worker = new ApToAtProjectionWorker(
      translator,
      projector,
      policy,
      ledger,
      writePort,
      projectionContext,
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: "full" },
    );

    const event = {
      id: "https://example.com/activities/worker-1",
      type: "Create",
      actor: "https://example.com/users/alice",
      object: {
        id: "https://example.com/notes/worker-1",
        type: "Note",
        content: "<p>Retry me</p>",
      },
    };

    const firstIntent = await worker.process(event, translationContext);
    expect(firstIntent?.kind).toBe("PostCreate");
    expect(writePort.apply).toHaveBeenCalledTimes(2);

    const secondIntent = await worker.process(event, translationContext);
    expect(secondIntent?.canonicalIntentId).toBe(firstIntent?.canonicalIntentId);
    expect(writePort.apply).toHaveBeenCalledTimes(2);
  });

  it("skips mirrored loopback in the AT->AP worker", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();
    const ledger = new InMemoryProjectionLedger();
    const publishPort = { publish: vi.fn().mockResolvedValue(undefined) };
    const policy = { evaluate: vi.fn().mockResolvedValue({ allowed: true }) };
    const worker = new AtToApProjectionWorker(
      translator,
      projector,
      policy,
      ledger,
      publishPort,
      projectionContext,
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: "full" },
    );

    const event = {
      repoDid: "did:plc:alice",
      uri: "at://did:plc:alice/app.bsky.feed.post/3kskip",
      operation: "create",
      bridge: {
        originProtocol: "activitypub",
        originEventId: "https://example.com/activities/loop-source",
        mirroredFromCanonicalIntentId: "canonical-loop",
        projectionMode: "mirrored",
      },
      record: {
        $type: "app.bsky.feed.post",
        text: "Do not loop",
      },
    };

    const intent = await worker.process(event, translationContext);
    expect(intent?.kind).toBe("PostCreate");
    expect(publishPort.publish).not.toHaveBeenCalled();
  });
});
