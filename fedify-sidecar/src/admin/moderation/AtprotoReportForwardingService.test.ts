import { afterEach, describe, expect, it, vi } from "vitest";
import { AtprotoReportForwardingService } from "./AtprotoReportForwardingService.js";
import type { AtprotoForwardingPlan } from "./activitypods-case-store.js";
import type { ModerationCase } from "./types.js";

class InMemoryCaseStore {
  readonly cases = new Map<string, ModerationCase>();

  constructor(
    entries: ModerationCase[],
    private readonly plans: Map<string, AtprotoForwardingPlan | null> = new Map(),
  ) {
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
              atproto:
                patch.forwarding.atproto && typeof patch.forwarding.atproto === "object"
                  ? {
                      ...(existing.forwarding?.atproto ?? {}),
                      ...patch.forwarding.atproto,
                    }
                  : patch.forwarding.atproto === null
                    ? null
                    : existing.forwarding?.atproto,
            }
          : existing.forwarding,
    };
    this.cases.set(id, structuredClone(merged));
    return structuredClone(merged);
  }

  async prepareAtprotoForwardingPlan(id: string): Promise<AtprotoForwardingPlan | null> {
    return structuredClone(this.plans.get(id) ?? null);
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
      did: "did:plc:alice123",
      handle: "alice.test",
    },
    reasonType: "harassment",
    reason: "Repeated abusive replies",
    requestedForwarding: { remote: true },
    clientContext: { app: "memory", surface: "report-sheet" },
    subject: {
      kind: "account",
      actor: {
        did: "did:plc:bob123",
        handle: "bob.test",
      },
      authoritativeProtocol: "at",
    },
    evidenceObjectRefs: [],
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
      did: "did:plc:alice123",
    },
    report: {
      subjectKind: "account",
      authoritativeProtocol: "at",
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

function makeReadyPlan(overrides: Partial<AtprotoForwardingPlan> = {}): AtprotoForwardingPlan {
  return {
    status: "ready",
    serviceDid: "did:plc:modservice123",
    pdsUrl: "https://pds.example",
    accessJwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.valid-token",
    reporterDid: "did:plc:alice123",
    reporterHandle: "alice.test",
    subjectDid: "did:plc:bob123",
    request: {
      reasonType: "com.atproto.moderation.defs#reasonRude",
      reason: "Repeated abusive replies",
      subject: {
        did: "did:plc:bob123",
      },
      modTool: {
        name: "ActivityPods",
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AtprotoReportForwardingService", () => {
  it("delivers a report through the reporter PDS with ATProto proxy headers", async () => {
    const caseStore = new InMemoryCaseStore(
      [makeCase()],
      new Map([["case-1", makeReadyPlan()]]),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ id: 42 })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new AtprotoReportForwardingService(caseStore as any);
    const result = await service.handleCanonicalEvent(makeEvent() as any);

    expect(result).toMatchObject({
      status: "delivered",
      caseId: "case-1",
      canonicalIntentId: "c".repeat(64),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pds.example/xrpc/com.atproto.moderation.createReport",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.valid-token",
          "atproto-proxy": "did:plc:modservice123#atproto_labeler",
          "content-type": "application/json",
        }),
      }),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual(
      expect.objectContaining({
        reasonType: "com.atproto.moderation.defs#reasonRude",
        subject: { did: "did:plc:bob123" },
      }),
    );

    const updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.atproto).toMatchObject({
      status: "delivered",
      canonicalIntentId: "c".repeat(64),
      serviceDid: "did:plc:modservice123",
      pdsUrl: "https://pds.example",
      reporterDid: "did:plc:alice123",
      subjectDid: "did:plc:bob123",
      reportId: 42,
      lastStatusCode: 200,
    });
  });

  it("marks forwarding as skipped when the ActivityPods plan says to skip", async () => {
    const caseStore = new InMemoryCaseStore(
      [makeCase()],
      new Map([["case-1", { status: "skipped", reason: "invalid_subject" }]]),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = new AtprotoReportForwardingService(caseStore as any);
    const result = await service.handleCanonicalEvent(makeEvent() as any);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "invalid_subject",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.atproto).toMatchObject({
      status: "skipped",
      skippedReason: "invalid_subject",
    });
  });

  it("leaves the case pending when the ATProto service fails retryably", async () => {
    const caseStore = new InMemoryCaseStore(
      [makeCase()],
      new Map([["case-1", makeReadyPlan()]]),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: "service_unavailable" })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new AtprotoReportForwardingService(
      caseStore as any,
      {
        requestRetries: 1,
        requestRetryBaseMs: 1,
        requestRetryMaxMs: 2,
      },
    );

    await expect(service.handleCanonicalEvent(makeEvent() as any)).rejects.toThrow(
      "ATProto moderation report failed (503)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.atproto).toMatchObject({
      status: "pending",
      serviceDid: "did:plc:modservice123",
      pdsUrl: "https://pds.example",
      subjectDid: "did:plc:bob123",
      lastStatusCode: 503,
    });
    expect(updated?.forwarding?.atproto?.lastError).toContain("ATProto moderation report failed (503)");
  });

  it("marks forwarding as failed on permanent credential rejection", async () => {
    const caseStore = new InMemoryCaseStore(
      [makeCase()],
      new Map([["case-1", makeReadyPlan()]]),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: "invalid_token" })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new AtprotoReportForwardingService(caseStore as any);
    const result = await service.handleCanonicalEvent(makeEvent() as any);

    expect(result).toMatchObject({
      status: "failed",
      reason: "failed",
    });

    const updated = await caseStore.getCase("case-1");
    expect(updated?.forwarding?.atproto).toMatchObject({
      status: "failed",
      lastStatusCode: 401,
      serviceDid: "did:plc:modservice123",
      pdsUrl: "https://pds.example",
      subjectDid: "did:plc:bob123",
    });
    expect(updated?.forwarding?.atproto?.lastError).toContain(
      "ATProto moderation service rejected reporter credentials",
    );
  });
});
