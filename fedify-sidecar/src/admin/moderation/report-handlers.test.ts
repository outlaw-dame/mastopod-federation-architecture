import { describe, expect, it, vi } from "vitest";
import { CanonicalIntentPublisher } from "../../protocol-bridge/canonical/CanonicalIntentPublisher.js";
import { handleIngestReportCreate, handleRetryReportForwarding } from "./report-handlers.js";
import type { ModerationCase } from "./types.js";

describe("handleIngestReportCreate", () => {
  it("publishes a canonical local report create intent for an account subject", async () => {
    const rawPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const canonicalPublisher = new CanonicalIntentPublisher(rawPublisher);

    const response = await handleIngestReportCreate(
      new Request("http://localhost/internal/bridge/moderation/reports", {
        method: "POST",
        headers: {
          authorization: "Bearer bridge-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "01JREPORTCASE00000000000001",
          reporterWebId: "https://pod.example/alice#me",
          sourceAccountRef: {
            canonicalAccountId: "https://pod.example/alice#me",
            webId: "https://pod.example/alice#me",
            activityPubActorUri: "https://pod.example/users/alice",
          },
          subject: {
            kind: "account",
            actor: {
              activityPubActorUri: "https://remote.example/users/bob",
            },
            authoritativeProtocol: "ap",
          },
          reasonType: "harassment",
          reason: "Targeted harassment",
          evidenceObjectRefs: [
            {
              canonicalObjectId: "https://remote.example/notes/123",
              activityPubObjectId: "https://remote.example/notes/123",
            },
          ],
          requestedForwarding: { remote: true },
          clientContext: { app: "memory", surface: "report-sheet" },
          createdAt: "2026-04-22T12:00:00.000Z",
          observedAt: "2026-04-22T12:00:05.000Z",
        }),
      }),
      {
        internalBridgeToken: "bridge-token",
        canonicalPublisher,
        now: () => "2026-04-22T12:00:05.000Z",
      },
    );

    expect(response.status).toBe(202);
    const payload = await response.json() as { ok: boolean; canonicalIntentId: string };
    expect(payload.ok).toBe(true);
    expect(payload.canonicalIntentId).toMatch(/^[a-f0-9]{64}$/);

    expect(rawPublisher.publish).toHaveBeenCalledTimes(1);
    expect(rawPublisher.publish).toHaveBeenCalledWith(
      "canonical.v1",
      expect.objectContaining({
        kind: "ReportCreate",
        sourceProtocol: "activitypods",
        actor: expect.objectContaining({
          webId: "https://pod.example/alice#me",
        }),
        report: expect.objectContaining({
          subjectKind: "account",
          authoritativeProtocol: "ap",
          reasonType: "harassment",
          requestedForwardingRemote: true,
          clientContext: { app: "memory", surface: "report-sheet" },
        }),
      }),
      expect.any(Object),
    );
  });
});

describe("handleRetryReportForwarding", () => {
  function makeCase(overrides: Partial<ModerationCase> = {}): ModerationCase {
    return {
      id: "01JREPORTCASE00000000000001",
      source: "local-user-report",
      protocol: "activitypods",
      dedupeKey: "dedupe-1",
      reporter: {
        canonicalAccountId: "https://pod.example/alice#me",
        webId: "https://pod.example/alice#me",
        activityPubActorUri: "https://pod.example/users/alice",
      },
      reasonType: "harassment",
      reason: "Targeted harassment",
      requestedForwarding: { remote: true },
      clientContext: { app: "memory", surface: "report-sheet" },
      subject: {
        kind: "account",
        actor: {
          activityPubActorUri: "https://remote.example/users/bob",
        },
        authoritativeProtocol: "ap",
      },
      evidenceObjectRefs: [],
      receivedAt: "2026-04-22T12:00:00.000Z",
      createdAt: "2026-04-22T12:00:00.000Z",
      status: "open",
      relatedDecisionIds: [],
      canonicalEvent: {
        status: "published",
        canonicalIntentId: "intent-1",
        publishedAt: "2026-04-22T12:00:05.000Z",
      },
      ...overrides,
    };
  }

  function makeDeps(caseRecord: ModerationCase) {
    const store = {
      getCase: vi.fn().mockResolvedValue(caseRecord),
    };

    return {
      adminToken: "admin-token",
      authorize: vi.fn(),
      store,
    } as any;
  }

  it("retries authoritative ActivityPub forwarding through the AP forwarder", async () => {
    const caseRecord = makeCase();
    const deps = makeDeps(caseRecord);
    const activityPubReportForwardingService = {
      handleCanonicalEvent: vi.fn().mockResolvedValue({
        status: "queued",
        caseId: caseRecord.id,
        canonicalIntentId: "f".repeat(64),
      }),
    };

    const response = await handleRetryReportForwarding(
      new Request(`http://localhost/internal/admin/moderation/cases/${caseRecord.id}/forwarding/retry`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
          "x-provider-permissions": "provider:write",
          "x-request-id": "retry-request-1",
        },
        body: JSON.stringify({
          protocols: ["activityPub"],
        }),
      }),
      deps,
      {
        caseId: caseRecord.id,
        activityPubReportForwardingService,
        now: () => "2026-04-22T13:00:00.000Z",
      },
    );

    expect(response.status).toBe(202);
    const payload = await response.json() as {
      ok: boolean;
      caseId: string;
      results: { activityPub?: { status: string } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.caseId).toBe(caseRecord.id);
    expect(payload.results.activityPub?.status).toBe("queued");
    expect(activityPubReportForwardingService.handleCanonicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ReportCreate",
        sourceEventId: `activitypods:report:${caseRecord.id}`,
        report: expect.objectContaining({
          authoritativeProtocol: "ap",
          requestedForwardingRemote: true,
        }),
      }),
    );
  });

  it("defaults to the case's authoritative protocol when protocols are omitted", async () => {
    const caseRecord = makeCase();
    const deps = makeDeps(caseRecord);
    const activityPubReportForwardingService = {
      handleCanonicalEvent: vi.fn().mockResolvedValue({
        status: "queued",
        caseId: caseRecord.id,
        canonicalIntentId: "b".repeat(64),
      }),
    };

    const response = await handleRetryReportForwarding(
      new Request(`http://localhost/internal/admin/moderation/cases/${caseRecord.id}/forwarding/retry`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "x-provider-permissions": "provider:write",
          "x-request-id": "retry-request-default",
        },
      }),
      deps,
      {
        caseId: caseRecord.id,
        activityPubReportForwardingService,
        now: () => "2026-04-22T13:05:00.000Z",
      },
    );

    expect(response.status).toBe(202);
    expect(activityPubReportForwardingService.handleCanonicalEvent).toHaveBeenCalledTimes(1);
    const payload = await response.json() as {
      results: { activityPub?: { status: string } };
    };
    expect(payload.results.activityPub?.status).toBe("queued");
  });

  it("returns already-forwarded without calling the forwarder when the case is already delivered", async () => {
    const caseRecord = makeCase({
      forwarding: {
        activityPub: {
          status: "delivered",
          canonicalIntentId: "c".repeat(64),
          deliveredAt: "2026-04-22T12:30:00.000Z",
        },
      },
    });
    const deps = makeDeps(caseRecord);
    const activityPubReportForwardingService = {
      handleCanonicalEvent: vi.fn(),
    };

    const response = await handleRetryReportForwarding(
      new Request(`http://localhost/internal/admin/moderation/cases/${caseRecord.id}/forwarding/retry`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
          "x-provider-permissions": "provider:write",
        },
        body: JSON.stringify({
          protocols: ["activityPub"],
        }),
      }),
      deps,
      {
        caseId: caseRecord.id,
        activityPubReportForwardingService,
      },
    );

    expect(response.status).toBe(202);
    expect(activityPubReportForwardingService.handleCanonicalEvent).not.toHaveBeenCalled();
    const payload = await response.json() as {
      results: { activityPub?: { status: string; reason?: string } };
    };
    expect(payload.results.activityPub).toEqual(
      expect.objectContaining({
        status: "already-forwarded",
        reason: "already_delivered",
      }),
    );
  });

  it("rejects protocol lists containing unsupported values", async () => {
    const caseRecord = makeCase();
    const deps = makeDeps(caseRecord);
    const activityPubReportForwardingService = {
      handleCanonicalEvent: vi.fn(),
    };

    await expect(handleRetryReportForwarding(
      new Request(`http://localhost/internal/admin/moderation/cases/${caseRecord.id}/forwarding/retry`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
          "x-provider-permissions": "provider:write",
        },
        body: JSON.stringify({
          protocols: ["activityPub", "bogus"],
        }),
      }),
      deps,
      {
        caseId: caseRecord.id,
        activityPubReportForwardingService,
      },
    )).rejects.toMatchObject({
      status: 400,
      message: "protocols must include 'activityPub' or 'atproto'",
    });

    expect(activityPubReportForwardingService.handleCanonicalEvent).not.toHaveBeenCalled();
  });

  it("rejects non-object JSON retry bodies", async () => {
    const caseRecord = makeCase();
    const deps = makeDeps(caseRecord);
    const activityPubReportForwardingService = {
      handleCanonicalEvent: vi.fn(),
    };

    await expect(handleRetryReportForwarding(
      new Request(`http://localhost/internal/admin/moderation/cases/${caseRecord.id}/forwarding/retry`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
          "x-provider-permissions": "provider:write",
        },
        body: JSON.stringify("activityPub"),
      }),
      deps,
      {
        caseId: caseRecord.id,
        activityPubReportForwardingService,
      },
    )).rejects.toMatchObject({
      status: 400,
      message: "Request body must be a JSON object",
    });

    expect(activityPubReportForwardingService.handleCanonicalEvent).not.toHaveBeenCalled();
  });

  it("returns pending when a retryable ATProto retry already updated the case to pending", async () => {
    const caseRecord = makeCase({
      subject: {
        kind: "account",
        actor: {
          did: "did:plc:bob123",
          handle: "bob.test",
        },
        authoritativeProtocol: "at",
      },
    });
    const pendingCase = makeCase({
      ...caseRecord,
      subject: caseRecord.subject,
      forwarding: {
        atproto: {
          status: "pending",
          canonicalIntentId: "a".repeat(64),
          subjectDid: "did:plc:bob123",
        },
      },
    });
    const store = {
      getCase: vi
        .fn()
        .mockResolvedValueOnce(caseRecord)
        .mockResolvedValueOnce(pendingCase),
    };
    const atprotoReportForwardingService = {
      handleCanonicalEvent: vi.fn(async (event) => {
        pendingCase.forwarding = {
          atproto: {
            status: "pending",
            canonicalIntentId: event.canonicalIntentId,
            subjectDid: "did:plc:bob123",
          },
        };
        throw new Error("temporary outage");
      }),
    };

    const response = await handleRetryReportForwarding(
      new Request(`http://localhost/internal/admin/moderation/cases/${caseRecord.id}/forwarding/retry`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
          "x-provider-permissions": "provider:write",
          "x-request-id": "retry-request-2",
        },
        body: JSON.stringify({
          protocols: ["atproto"],
        }),
      }),
      {
        adminToken: "admin-token",
        authorize: vi.fn(),
        store,
      } as any,
      {
        caseId: caseRecord.id,
        atprotoReportForwardingService,
        now: () => "2026-04-22T13:00:00.000Z",
      },
    );

    expect(response.status).toBe(202);
    const payload = await response.json() as {
      results: { atproto?: { status: string; reason?: string } };
    };
    expect(payload.results.atproto).toEqual(
      expect.objectContaining({
        status: "pending",
        reason: "retryable_error",
      }),
    );
  });
});
