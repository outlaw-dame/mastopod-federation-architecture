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
  overrides: Partial<Pick<ModerationBridgeDeps, "updateAtSubjectStatus" | "resolveAtDid" | "resolveWebId">> = {},
): ModerationBridgeDeps {
  return {
    adminToken: "admin-token",
    store: {
      addDecision: vi.fn().mockResolvedValue(undefined),
      listDecisions: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      getDecision: vi.fn().mockResolvedValue(null),
      patchDecision: vi.fn().mockResolvedValue(null),
      addAtLabel: vi.fn().mockResolvedValue(undefined),
      listAtLabels: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
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
    mrfInternalFetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { config: { config: { blockedLabels: [], warnLabels: [] } } } }), {
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
});
