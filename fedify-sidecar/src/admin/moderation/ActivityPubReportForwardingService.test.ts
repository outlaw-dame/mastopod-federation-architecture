import { describe, expect, it, vi } from "vitest";
import {
  ActivityPubReportForwardingService,
  buildModerationActorUri,
  buildModerationOutboxIntentId,
} from "./ActivityPubReportForwardingService.js";
import type { ModerationCase } from "./types.js";
import type { OutboundDeliveryModerationReportMeta } from "../../core-domain/contracts/SigningContracts.js";

class InMemoryCaseStore {
  readonly cases = new Map<string, ModerationCase>();

  constructor(entries: ModerationCase[]) {
    for (const entry of entries) {
      this.cases.set(entry.id, structuredClone(entry));
    }
  }

  async getCase(id: string): Promise<ModerationCase | null> {
    return structuredClone(this.cases.get(id) ?? null);
  }

  async patchCase(id: string, patch: Partial<ModerationCase>): Promise<ModerationCase | null> {
    const existing = this.cases.get(id);
    if (!existing) return null;
    const merged: ModerationCase = {
      ...existing,
      ...patch,
      forwarding:
        patch.forwarding && typeof patch.forwarding === "object"
          ? {
              ...(existing.forwarding ?? {}),
              ...patch.forwarding,
            }
          : existing.forwarding,
    };
    this.cases.set(id, structuredClone(merged));
    return structuredClone(merged);
  }
}

function makeCase(overrides: Partial<ModerationCase> = {}): ModerationCase {
  return {
    id: "case-1",
    source: "local-user-report",
    protocol: "activitypods",
    dedupeKey: "dedupe-1",
    reporter: {
      canonicalAccountId: "https://pod.example/alice#me",
      webId: "https://pod.example/alice#me",
      activityPubActorUri: "https://local.example/users/alice",
    },
    reasonType: "harassment",
    reason: "Repeated abusive replies",
    requestedForwarding: { remote: true },
    clientContext: { app: "memory", surface: "report-sheet" },
    subject: {
      kind: "account",
      actor: {
        activityPubActorUri: "https://remote.example/users/bob",
      },
      authoritativeProtocol: "ap",
    },
    evidenceObjectRefs: [
      {
        canonicalObjectId: "https://remote.example/notes/1",
        activityPubObjectId: "https://remote.example/notes/1",
      },
    ],
    receivedAt: "2026-04-22T12:00:00.000Z",
    createdAt: "2026-04-22T12:00:00.000Z",
    status: "open",
    relatedDecisionIds: [],
    canonicalEvent: {
      status: "published",
      canonicalIntentId: "intent-1",
      publishedAt: "2026-04-22T12:00:00.000Z",
    },
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    canonicalIntentId: "c".repeat(64),
    kind: "ReportCreate",
    sourceProtocol: "activitypods",
    sourceEventId: "activitypods:report:case-1",
    actor: {
      webId: "https://pod.example/alice#me",
      activityPubActorUri: "https://local.example/users/alice",
    },
    report: {
      subjectKind: "account",
      authoritativeProtocol: "ap",
      reasonType: "harassment",
      reason: "Repeated abusive replies",
      evidence: [],
      requestedForwardingRemote: true,
      clientContext: {
        app: "memory",
        surface: "report-sheet",
      },
    },
    createdAt: "2026-04-22T12:00:00.000Z",
    ...overrides,
  };
}

function makeRequestMock(routes: Record<string, Array<Record<string, unknown>>>) {
  return vi.fn(async (url: string) => {
    const queue = routes[url];
    if (!queue || queue.length === 0) {
      throw new Error(`Unexpected request for ${url}`);
    }
    const next = queue.shift()!;
    return {
      statusCode: Number(next["statusCode"] ?? 200),
      headers: next["headers"] ?? {},
      body: {
        text: vi.fn().mockResolvedValue(
          typeof next["body"] === "string" ? next["body"] : JSON.stringify(next["body"] ?? {}),
        ),
      },
    } as any;
  });
}

describe("ActivityPubReportForwardingService", () => {
  it("queues a deterministic outbound Flag for a remote account report", async () => {
    const caseStore = new InMemoryCaseStore([
      makeCase({
        forwarding: {
          activityPub: {
            status: "failed",
            canonicalIntentId: "old-intent",
            activityId: "https://local.example/users/moderation/flags/old-intent",
            outboxIntentId: "moderation-report:old-intent",
            targetActorUri: "https://old.example/users/old-bob",
            targetInbox: "https://old.example/inbox",
            targetDomain: "old.example",
            queuedAt: "2026-04-22T11:58:00.000Z",
            deliveredAt: "2026-04-22T11:59:00.000Z",
            lastError: "HTTP 500",
            skippedReason: "old_reason",
            lastStatusCode: 500,
          },
        },
      }),
    ]);
    const queue = {
      enqueueOutboxIntent: vi.fn().mockResolvedValue("msg-1"),
    };
    const requestMock = makeRequestMock({
      "https://remote.example/users/bob": [
        {
          body: {
            id: "https://remote.example/users/bob",
            inbox: "https://remote.example/inbox",
          },
        },
      ],
    });

    const service = new ActivityPubReportForwardingService(
      queue as any,
      caseStore as any,
      { domain: "local.example" },
      undefined,
      requestMock as any,
    );

    const result = await service.handleCanonicalEvent(makeEvent() as any);

    expect(result).toMatchObject({
      status: "queued",
      caseId: "case-1",
    });
    expect(queue.enqueueOutboxIntent).toHaveBeenCalledTimes(1);

    const enqueued = queue.enqueueOutboxIntent.mock.calls[0]?.[0];
    expect(enqueued).toMatchObject({
      intentId: buildModerationOutboxIntentId("c".repeat(64)),
      actorUri: buildModerationActorUri("local.example"),
      targets: [
        expect.objectContaining({
          deliveryUrl: "https://remote.example/inbox",
          targetDomain: "remote.example",
        }),
      ],
      meta: expect.objectContaining({
        visibility: "direct",
        moderationReport: expect.objectContaining({
          caseId: "case-1",
          canonicalIntentId: "c".repeat(64),
        }),
      }),
    });

    const activity = JSON.parse(enqueued.activity);
    expect(activity).toMatchObject({
      type: "Flag",
      actor: buildModerationActorUri("local.example"),
      to: ["https://remote.example/users/bob"],
      object: [
        "https://remote.example/users/bob",
        "https://remote.example/notes/1",
      ],
      content: "Repeated abusive replies",
    });

    const updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.activityPub).toMatchObject({
      status: "queued",
      canonicalIntentId: "c".repeat(64),
      targetActorUri: "https://remote.example/users/bob",
      targetInbox: "https://remote.example/inbox",
      targetDomain: "remote.example",
    });
    expect(updated?.forwarding?.activityPub?.deliveredAt).toBeUndefined();
    expect(updated?.forwarding?.activityPub?.lastError).toBeUndefined();
    expect(updated?.forwarding?.activityPub?.skippedReason).toBeUndefined();
    expect(updated?.forwarding?.activityPub?.lastStatusCode).toBeUndefined();
  });

  it("marks ActivityPub forwarding as skipped when remote forwarding was not requested", async () => {
    const caseStore = new InMemoryCaseStore([
      makeCase({
        requestedForwarding: { remote: false },
      }),
    ]);
    const queue = {
      enqueueOutboxIntent: vi.fn().mockResolvedValue("msg-1"),
    };

    const service = new ActivityPubReportForwardingService(
      queue as any,
      caseStore as any,
      { domain: "local.example" },
    );

    const result = await service.handleCanonicalEvent(makeEvent() as any);

    expect(result.status).toBe("skipped");
    expect(queue.enqueueOutboxIntent).not.toHaveBeenCalled();
    const updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.activityPub).toMatchObject({
      status: "skipped",
      skippedReason: "not_requested",
    });
  });

  it("resolves an object report through the object document when the owner is missing", async () => {
    const caseStore = new InMemoryCaseStore([
      makeCase({
        subject: {
          kind: "object",
          object: {
            canonicalObjectId: "https://remote.example/notes/44",
            activityPubObjectId: "https://remote.example/notes/44",
          },
          authoritativeProtocol: "ap",
        },
        evidenceObjectRefs: [],
      }),
    ]);
    const queue = {
      enqueueOutboxIntent: vi.fn().mockResolvedValue("msg-1"),
    };
    const requestMock = makeRequestMock({
      "https://remote.example/notes/44": [
        {
          body: {
            id: "https://remote.example/notes/44",
            attributedTo: "https://remote.example/users/owner",
          },
        },
      ],
      "https://remote.example/users/owner": [
        {
          body: {
            id: "https://remote.example/users/owner",
            inbox: "https://remote.example/users/owner/inbox",
          },
        },
      ],
    });

    const service = new ActivityPubReportForwardingService(
      queue as any,
      caseStore as any,
      { domain: "local.example" },
      undefined,
      requestMock as any,
    );

    const result = await service.handleCanonicalEvent(
      makeEvent({
        report: {
          subjectKind: "object",
          authoritativeProtocol: "ap",
          reasonType: "harassment",
          requestedForwardingRemote: true,
        },
      }) as any,
    );

    expect(result.status).toBe("queued");
    const enqueued = queue.enqueueOutboxIntent.mock.calls[0]?.[0];
    const activity = JSON.parse(enqueued.activity);
    expect(activity.object).toEqual([
      "https://remote.example/users/owner",
      "https://remote.example/notes/44",
    ]);
  });

  it("records delivered and failed outbound moderation report states", async () => {
    const canonicalIntentId = "d".repeat(64);
    const caseStore = new InMemoryCaseStore([
      makeCase({
        forwarding: {
          activityPub: {
            status: "queued",
            canonicalIntentId,
            targetActorUri: "https://remote.example/users/bob",
            targetInbox: "https://remote.example/inbox",
            targetDomain: "remote.example",
          },
        },
      }),
    ]);

    const service = new ActivityPubReportForwardingService(
      { enqueueOutboxIntent: vi.fn().mockResolvedValue("msg-1") } as any,
      caseStore as any,
      { domain: "local.example" },
    );

    const meta: OutboundDeliveryModerationReportMeta = {
      protocol: "activitypub",
      caseId: "case-1",
      canonicalIntentId,
      targetActorUri: "https://remote.example/users/bob",
    };

    await service.markDelivered(meta, {
      targetDomain: "remote.example",
      statusCode: 202,
    });
    let updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.activityPub).toMatchObject({
      status: "delivered",
      lastStatusCode: 202,
    });

    await service.markFailed("case-1", meta, {
      error: "HTTP 410 Gone",
      targetDomain: "remote.example",
      targetInbox: "https://remote.example/inbox",
      statusCode: 410,
      responseBody: "gone",
      attempt: 3,
    });
    updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.activityPub).toMatchObject({
      status: "failed",
      targetInbox: "https://remote.example/inbox",
      lastStatusCode: 410,
    });
    expect(updated?.forwarding?.activityPub?.lastError).toContain("HTTP 410 Gone");
  });
});
