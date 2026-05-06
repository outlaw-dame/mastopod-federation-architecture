import { describe, expect, it, vi } from "vitest";
import { handleApplyDecision, handleRevokeDecision } from "./handlers.js";
import type { ModerationBridgeDeps, ModerationDecision } from "./types.js";

function makeApplyRequest(body: unknown): Request {
  return new Request("http://localhost/internal/admin/moderation/decisions", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-token",
      "content-type": "application/json",
      "x-provider-permissions": "provider:write",
    },
    body: JSON.stringify(body),
  });
}

function makeRevokeRequest(id: string): Request {
  return new Request(`http://localhost/internal/admin/moderation/decisions/${id}`, {
    method: "DELETE",
    headers: {
      authorization: "Bearer admin-token",
      "x-provider-permissions": "provider:write",
    },
  });
}

function makeSubjectPolicyModuleResponse(revision: number, rules: unknown[] = []): Response {
  return new Response(JSON.stringify({
    data: {
      config: {
        enabled: true,
        mode: "enforce",
        revision,
        config: {
          rules,
          traceReasons: true,
        },
      },
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeDeps(
  overrides: Partial<ModerationBridgeDeps> = {},
): ModerationBridgeDeps {
  return {
    adminToken: "admin-token",
    store: {
      addDecision: vi.fn().mockResolvedValue(undefined),
      listDecisions: vi.fn().mockResolvedValue({ decisions: [], cursor: undefined }),
      getDecision: vi.fn().mockResolvedValue(null),
      patchDecision: vi.fn().mockImplementation(async (_id, patch) => ({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        source: "provider-dashboard",
        action: "block",
        labels: ["!hide"],
        appliedBy: "provider:admin",
        appliedAt: "2026-04-21T12:00:00.000Z",
        protocols: "ap",
        mrfPatched: true,
        atLabelEmitted: false,
        atStatusUpdated: false,
        revoked: true,
        ...patch,
      })),
      addCase: vi.fn().mockResolvedValue(undefined),
      getCase: vi.fn().mockResolvedValue(null),
      findCaseByDedupeKey: vi.fn().mockResolvedValue(null),
      listCases: vi.fn().mockResolvedValue({ cases: [], cursor: undefined }),
      patchCase: vi.fn().mockResolvedValue(null),
      addAtLabel: vi.fn().mockResolvedValue(undefined),
      listAtLabels: vi.fn().mockResolvedValue({ labels: [], cursor: 0 }),
    },
    mrfInternalFetch: vi.fn().mockResolvedValue(makeSubjectPolicyModuleResponse(0)),
    labelEmitter: {
      emit: vi.fn().mockResolvedValue({
        src: "did:web:test",
        uri: "did:plc:test",
        val: "!hide",
        cts: "2026-04-21T12:00:00.000Z",
      }),
      negate: vi.fn().mockResolvedValue({
        src: "did:web:test",
        uri: "did:plc:test",
        val: "!hide",
        neg: true,
        cts: "2026-04-21T12:00:00.000Z",
      }),
    },
    updateAtSubjectStatus: vi.fn().mockResolvedValue(false),
    resolveAtDid: vi.fn().mockResolvedValue(null),
    resolveWebId: vi.fn().mockResolvedValue(null),
    resolveActivityPubActorUri: vi.fn().mockResolvedValue(null),
    resolveWebIdForActorUri: vi.fn().mockResolvedValue(null),
    now: () => "2026-04-21T12:00:00.000Z",
    uuid: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    actorFromRequest: () => "provider:admin",
    authorize: () => undefined,
    ...overrides,
  };
}

describe("ActivityPub subject-policy bridge", () => {
  it("applies an AP-only rule when a target actor URI is provided", async () => {
    const mrfInternalFetch = vi.fn()
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(0))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deps = makeDeps({ mrfInternalFetch });

    const response = await handleApplyDecision(makeApplyRequest({
      targetActorUri: "https://remote.example/users/alice",
      action: "block",
      reason: "remote abuse",
    }), deps);

    expect(response.status).toBe(201);
    const payload = await response.json() as { decision: ModerationDecision };
    expect(payload.decision.targetActorUri).toBe("https://remote.example/users/alice");
    expect(payload.decision.mrfPatched).toBe(true);
    expect(payload.decision.atLabelEmitted).toBe(false);
    expect(payload.decision.protocols).toBe("ap");

    expect(mrfInternalFetch).toHaveBeenCalledTimes(2);
    const patchBody = (mrfInternalFetch.mock.calls[1] ?? [])[0]?.body as Record<string, unknown>;
    expect(patchBody?.["mode"]).toBe("enforce");
    expect(((patchBody?.["config"] as Record<string, unknown> | undefined)?.["rules"]) ).toEqual([
      expect.objectContaining({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        action: "reject",
        actorUri: "https://remote.example/users/alice",
      }),
    ]);
  });

  it("reports both protocols when AT and AP propagation both succeed", async () => {
    const mrfInternalFetch = vi.fn()
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(0))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deps = makeDeps({
      mrfInternalFetch,
      resolveAtDid: vi.fn().mockResolvedValue("did:plc:alice123"),
      resolveActivityPubActorUri: vi.fn().mockResolvedValue("https://pod.example/users/alice"),
    });

    const response = await handleApplyDecision(makeApplyRequest({
      targetWebId: "https://pod.example/alice/profile/card#me",
      action: "filter",
    }), deps);

    expect(response.status).toBe(201);
    const payload = await response.json() as { decision: ModerationDecision };
    expect(payload.decision.targetActorUri).toBe("https://pod.example/users/alice");
    expect(payload.decision.targetAtDid).toBe("did:plc:alice123");
    expect(payload.decision.protocols).toBe("both");
  });

  it("retries AP module patching on revision conflict", async () => {
    const mrfInternalFetch = vi.fn()
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(0))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "conflict" }), { status: 409 }))
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(1))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deps = makeDeps({ mrfInternalFetch });

    const response = await handleApplyDecision(makeApplyRequest({
      targetActorUri: "https://remote.example/users/bob",
      action: "filter",
    }), deps);

    expect(response.status).toBe(201);
    const payload = await response.json() as { decision: ModerationDecision };
    expect(payload.decision.protocols).toBe("ap");
    expect(mrfInternalFetch).toHaveBeenCalledTimes(4);
  });

  it("applies a provider server-domain limit as an ActivityPub filter rule", async () => {
    const mrfInternalFetch = vi.fn()
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(0))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deps = makeDeps({ mrfInternalFetch });

    const response = await handleApplyDecision(makeApplyRequest({
      targetDomain: "Remote.Example:443",
      action: "filter",
      reason: "limit remote server",
    }), deps);

    expect(response.status).toBe(201);
    const payload = await response.json() as { decision: ModerationDecision };
    expect(payload.decision.targetDomain).toBe("remote.example");
    expect(payload.decision.protocols).toBe("ap");
    expect(payload.decision.mrfPatched).toBe(true);
    expect(payload.decision.atLabelEmitted).toBe(false);

    const patchBody = (mrfInternalFetch.mock.calls[1] ?? [])[0]?.body as Record<string, unknown>;
    expect(((patchBody?.["config"] as Record<string, unknown> | undefined)?.["rules"]) ).toEqual([
      expect.objectContaining({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        action: "filter",
        domain: "remote.example",
      }),
    ]);
  });

  it("maps Mastodon domain severity silence to the internal ActivityPub filter action", async () => {
    const mrfInternalFetch = vi.fn()
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(0))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deps = makeDeps({ mrfInternalFetch });

    const response = await handleApplyDecision(makeApplyRequest({
      targetDomain: "remote.example",
      domainBlockSeverity: "silence",
      action: "label",
      rejectMedia: true,
      rejectReports: "false",
      publicComment: "Limited for spam waves",
      privateComment: "Imported from provider review",
      obfuscate: false,
    }), deps);

    expect(response.status).toBe(201);
    const payload = await response.json() as { decision: ModerationDecision };
    expect(payload.decision).toEqual(expect.objectContaining({
      targetDomain: "remote.example",
      domainBlockSeverity: "silence",
      rejectMedia: true,
      rejectReports: false,
      publicComment: "Limited for spam waves",
      privateComment: "Imported from provider review",
      obfuscate: false,
      protocols: "ap",
      mrfPatched: true,
    }));

    const patchBody = (mrfInternalFetch.mock.calls[1] ?? [])[0]?.body as Record<string, unknown>;
    expect(((patchBody?.["config"] as Record<string, unknown> | undefined)?.["rules"]) ).toEqual([
      expect.objectContaining({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        action: "filter",
        domain: "remote.example",
      }),
    ]);
  });

  it("maps Mastodon domain severity suspend to the internal ActivityPub reject action", async () => {
    const mrfInternalFetch = vi.fn()
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(0))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deps = makeDeps({ mrfInternalFetch });

    const response = await handleApplyDecision(makeApplyRequest({
      targetDomain: "remote.example",
      domainBlockSeverity: "suspend",
      action: "label",
    }), deps);

    expect(response.status).toBe(201);
    const patchBody = (mrfInternalFetch.mock.calls[1] ?? [])[0]?.body as Record<string, unknown>;
    expect(((patchBody?.["config"] as Record<string, unknown> | undefined)?.["rules"]) ).toEqual([
      expect.objectContaining({
        action: "reject",
        domain: "remote.example",
      }),
    ]);
  });

  it("records Mastodon domain severity noop without patching AP subject policy", async () => {
    const mrfInternalFetch = vi.fn().mockResolvedValue(makeSubjectPolicyModuleResponse(0));
    const deps = makeDeps({ mrfInternalFetch });

    const response = await handleApplyDecision(makeApplyRequest({
      targetDomain: "remote.example",
      domainBlockSeverity: "noop",
      action: "label",
    }), deps);

    expect(response.status).toBe(201);
    const payload = await response.json() as { decision: ModerationDecision };
    expect(payload.decision).toEqual(expect.objectContaining({
      targetDomain: "remote.example",
      domainBlockSeverity: "noop",
      protocols: "none",
      mrfPatched: false,
    }));
    expect(mrfInternalFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed provider server-domain targets", async () => {
    const deps = makeDeps();

    await expect(handleApplyDecision(makeApplyRequest({
      targetDomain: "127.0.0.1",
      action: "filter",
    }), deps)).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });

  it("removes the exact AP rule by decision id on revoke", async () => {
    const decision: ModerationDecision = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      source: "provider-dashboard",
      targetActorUri: "https://remote.example/users/alice",
      targetWebId: "https://pod.example/alice/profile/card#me",
      action: "block",
      labels: ["!hide"],
      appliedBy: "provider:admin",
      appliedAt: "2026-04-21T12:00:00.000Z",
      protocols: "ap",
      mrfPatched: true,
      atLabelEmitted: false,
      atStatusUpdated: false,
      revoked: false,
    };
    const mrfInternalFetch = vi.fn()
      .mockResolvedValueOnce(makeSubjectPolicyModuleResponse(4, [
        {
          id: decision.id,
          action: "reject",
          actorUri: "https://remote.example/users/alice",
        },
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const store = {
      addDecision: vi.fn().mockResolvedValue(undefined),
      listDecisions: vi.fn().mockResolvedValue({ decisions: [], cursor: undefined }),
      getDecision: vi.fn().mockResolvedValue(decision),
      patchDecision: vi.fn().mockResolvedValue({ ...decision, revoked: true, revokedAt: "2026-04-21T12:10:00.000Z", revokedBy: "provider:admin" }),
      addCase: vi.fn().mockResolvedValue(undefined),
      getCase: vi.fn().mockResolvedValue(null),
      findCaseByDedupeKey: vi.fn().mockResolvedValue(null),
      listCases: vi.fn().mockResolvedValue({ cases: [], cursor: undefined }),
      patchCase: vi.fn().mockResolvedValue(null),
      addAtLabel: vi.fn().mockResolvedValue(undefined),
      listAtLabels: vi.fn().mockResolvedValue({ labels: [], cursor: 0 }),
    };
    const deps = makeDeps({ mrfInternalFetch, store });

    const response = await handleRevokeDecision(makeRevokeRequest(decision.id), deps, decision.id);

    expect(response.status).toBe(200);
    expect(mrfInternalFetch).toHaveBeenCalledTimes(2);
    const patchBody = (mrfInternalFetch.mock.calls[1] ?? [])[0]?.body as Record<string, unknown>;
    expect(((patchBody?.["config"] as Record<string, unknown> | undefined)?.["rules"]) ).toEqual([]);
    expect(store.patchDecision).toHaveBeenCalledWith(decision.id, expect.objectContaining({
      revoked: true,
      revokedBy: "provider:admin",
    }));
  });

  it("marks a linked moderation case resolved when a decision is applied from it", async () => {
    const moderationCase = {
      id: "case-000000000001",
      source: "activitypub-flag" as const,
      protocol: "ap" as const,
      dedupeKey: "dedupe-1",
      sourceActorUri: "https://remote.example/users/reporter",
      inboxPath: "/users/alice/inbox",
      reportedUris: ["https://remote.example/users/alice"],
      reportedActorUris: ["https://remote.example/users/alice"],
      receivedAt: "2026-04-21T11:55:00.000Z",
      status: "open" as const,
      relatedDecisionIds: [],
    };
    const store = {
      addDecision: vi.fn().mockResolvedValue(undefined),
      listDecisions: vi.fn().mockResolvedValue({ decisions: [], cursor: undefined }),
      getDecision: vi.fn().mockResolvedValue(null),
      patchDecision: vi.fn().mockResolvedValue(null),
      addCase: vi.fn().mockResolvedValue(undefined),
      getCase: vi.fn().mockResolvedValue(moderationCase),
      findCaseByDedupeKey: vi.fn().mockResolvedValue(null),
      listCases: vi.fn().mockResolvedValue({ cases: [moderationCase], cursor: undefined }),
      patchCase: vi.fn().mockResolvedValue({
        ...moderationCase,
        status: "resolved",
        relatedDecisionIds: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      }),
      addAtLabel: vi.fn().mockResolvedValue(undefined),
      listAtLabels: vi.fn().mockResolvedValue({ labels: [], cursor: 0 }),
    };
    const deps = makeDeps({ store });

    const response = await handleApplyDecision(makeApplyRequest({
      sourceCaseId: moderationCase.id,
      targetActorUri: "https://remote.example/users/alice",
      action: "block",
      reason: "confirmed abuse",
    }), deps);

    expect(response.status).toBe(201);
    expect(store.patchCase).toHaveBeenCalledWith(
      moderationCase.id,
      expect.objectContaining({
        status: "resolved",
        resolvedBy: "provider:admin",
        relatedDecisionIds: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      }),
    );
  });
});
