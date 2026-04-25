import { describe, expect, it, vi } from "vitest";
import { handleApplyDecision } from "./handlers.js";
import type { ModerationBridgeDeps, ModerationDecision } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
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

function makeDeps(
  overrides: Partial<Pick<
    ModerationBridgeDeps,
    "updateAtSubjectStatus" | "resolveAtDid" | "resolveWebId" | "resolveActivityPubActorUri"
  >> = {},
): ModerationBridgeDeps {
  return {
    adminToken: "admin-token",
    store: {
      addDecision: vi.fn().mockResolvedValue(undefined),
      listDecisions: vi.fn().mockResolvedValue({ decisions: [], cursor: undefined }),
      getDecision: vi.fn().mockResolvedValue(null),
      patchDecision: vi.fn().mockResolvedValue(null),
      addCase: vi.fn().mockResolvedValue(undefined),
      getCase: vi.fn().mockResolvedValue(null),
      findCaseByDedupeKey: vi.fn().mockResolvedValue(null),
      listCases: vi.fn().mockResolvedValue({ cases: [], cursor: undefined }),
      patchCase: vi.fn().mockResolvedValue(null),
      addAtLabel: vi.fn().mockResolvedValue(undefined),
      listAtLabels: vi.fn().mockResolvedValue({ labels: [], cursor: 0 }),
    },
    labelEmitter: {
      emit: vi.fn().mockResolvedValue({ src: "did:web:test", uri: "did:example:alice", val: "!hide", cts: "2026-01-01T00:00:00.000Z" }),
      negate: vi.fn().mockResolvedValue({ src: "did:web:test", uri: "did:example:alice", val: "!hide", neg: true, cts: "2026-01-01T00:00:00.000Z" }),
    },
    now: () => "2026-04-06T00:00:00.000Z",
    uuid: () => "test-decision-id",
    actorFromRequest: () => "provider:admin",
    authorize: () => undefined,
    resolveAtDid: overrides.resolveAtDid ?? vi.fn().mockResolvedValue(null),
    resolveWebId: overrides.resolveWebId ?? vi.fn().mockResolvedValue(null),
    resolveActivityPubActorUri: overrides.resolveActivityPubActorUri ?? vi.fn().mockResolvedValue(null),
    resolveWebIdForActorUri: vi.fn().mockResolvedValue(null),
    mrfInternalFetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          config: {
            enabled: true,
            mode: "enforce",
            revision: 0,
            config: {
              rules: [],
              traceReasons: true,
            },
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
    updateAtSubjectStatus: overrides.updateAtSubjectStatus,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("suspend action", () => {
  it("sets atStatusUpdated=true when AT admin hook succeeds", async () => {
    const updateAtSubjectStatus = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveAtDid: vi.fn().mockResolvedValue(null),
      updateAtSubjectStatus,
    });

    const response = await handleApplyDecision(
      makeRequest({
        targetAtDid: "did:plc:examplealice1234",
        action: "suspend",
        reason: "Violation of terms",
      }),
      deps,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { decision: ModerationDecision };
    expect(payload.decision.atStatusUpdated).toBe(true);
    expect(payload.decision.atLabelEmitted).toBe(true);
    expect(payload.decision.mrfPatched).toBe(false);
    expect(payload.decision.protocols).toBe("at");
    expect(payload.decision.action).toBe("suspend");
    expect(updateAtSubjectStatus).toHaveBeenCalledTimes(1);
    expect(updateAtSubjectStatus).toHaveBeenCalledWith({
      did: "did:plc:examplealice1234",
      reason: "Violation of terms",
    });
  });

  it("sets atStatusUpdated=false when AT admin hook returns false", async () => {
    const updateAtSubjectStatus = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({ updateAtSubjectStatus });

    const response = await handleApplyDecision(
      makeRequest({
        targetAtDid: "did:plc:examplealice1234",
        action: "suspend",
      }),
      deps,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { decision: ModerationDecision };
    expect(payload.decision.atStatusUpdated).toBe(false);
    // Labels should still have been emitted
    expect(payload.decision.atLabelEmitted).toBe(true);
  });

  it("sets atStatusUpdated=false when AT admin hook throws", async () => {
    const updateAtSubjectStatus = vi.fn().mockRejectedValue(new Error("PDS unreachable"));
    const deps = makeDeps({ updateAtSubjectStatus });

    const response = await handleApplyDecision(
      makeRequest({
        targetAtDid: "did:plc:examplealice1234",
        action: "suspend",
      }),
      deps,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { decision: ModerationDecision };
    expect(payload.decision.atStatusUpdated).toBe(false);
    expect(payload.decision.atLabelEmitted).toBe(true);
  });

  it("does not call AT admin hook when no updateAtSubjectStatus dep is provided", async () => {
    // No updateAtSubjectStatus in deps (optional field absent)
    const deps = makeDeps();

    const response = await handleApplyDecision(
      makeRequest({
        targetAtDid: "did:plc:examplealice1234",
        action: "suspend",
      }),
      deps,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { decision: ModerationDecision };
    // Best-effort: atStatusUpdated stays false without the hook
    expect(payload.decision.atStatusUpdated).toBe(false);
    // Labels should still be emitted
    expect(payload.decision.atLabelEmitted).toBe(true);
  });

  it("does not call AT admin hook for non-suspend actions", async () => {
    const updateAtSubjectStatus = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ updateAtSubjectStatus });

    await handleApplyDecision(
      makeRequest({
        targetAtDid: "did:plc:examplealice1234",
        action: "block",
      }),
      deps,
    );

    expect(updateAtSubjectStatus).not.toHaveBeenCalled();
  });

  it("resolves DID from WebID when only WebID is given", async () => {
    const updateAtSubjectStatus = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveAtDid: vi.fn().mockResolvedValue("did:plc:resolvedfrompod"),
      updateAtSubjectStatus,
    });

    const response = await handleApplyDecision(
      makeRequest({
        targetWebId: "https://pods.example.com/users/alice",
        action: "suspend",
        reason: "Resolved via WebID binding",
      }),
      deps,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { decision: ModerationDecision };
    expect(payload.decision.atStatusUpdated).toBe(true);
    expect(updateAtSubjectStatus).toHaveBeenCalledWith({
      did: "did:plc:resolvedfrompod",
      reason: "Resolved via WebID binding",
    });
  });

  it("records no AP propagation when the target cannot be resolved to an AT DID", async () => {
    const deps = makeDeps({
      resolveAtDid: vi.fn().mockResolvedValue(null),
    });

    const response = await handleApplyDecision(
      makeRequest({
        targetWebId: "https://pods.example.com/users/alice",
        action: "warn",
      }),
      deps,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { decision: ModerationDecision };
    expect(payload.decision.targetWebId).toBe("https://pods.example.com/users/alice");
    expect(payload.decision.targetAtDid).toBeUndefined();
    expect(payload.decision.atLabelEmitted).toBe(false);
    expect(payload.decision.mrfPatched).toBe(false);
    expect(payload.decision.protocols).toBe("none");
  });
});
