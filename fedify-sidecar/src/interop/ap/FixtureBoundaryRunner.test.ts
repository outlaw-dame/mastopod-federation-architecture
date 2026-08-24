import { describe, expect, it } from "vitest";
import {
  runActivityStreamsStructureCheck,
  runAuthorityPolicyCheck,
  runReplayIdempotencyCheck,
} from "./FixtureBoundaryRunner.js";

describe("runActivityStreamsStructureCheck", () => {
  it("accepts a well-formed Follow", () => {
    expect(
      runActivityStreamsStructureCheck({ type: "Follow", actor: "https://a.example/x", object: "https://a.example/y" }),
    ).toEqual({ outcome: "tolerant_accept" });
  });

  it("tolerates actor expressed as a single-element array", () => {
    expect(
      runActivityStreamsStructureCheck({ type: "Follow", actor: ["https://a.example/x"], object: "https://a.example/y" }),
    ).toEqual({ outcome: "tolerant_accept" });
  });

  it("rejects a Follow with no object", () => {
    const result = runActivityStreamsStructureCheck({ type: "Follow", actor: "https://a.example/x" });
    expect(result.outcome).toBe("rejected_parse");
  });

  it("rejects a Create with no actor", () => {
    const result = runActivityStreamsStructureCheck({
      type: "Create",
      object: { type: "Note", attributedTo: "https://a.example/x" },
    });
    expect(result.outcome).toBe("rejected_parse");
  });

  it("rejects a Create whose object is missing attributedTo", () => {
    const result = runActivityStreamsStructureCheck({
      type: "Create",
      actor: "https://a.example/x",
      object: { type: "Note" },
    });
    expect(result.outcome).toBe("rejected_parse");
  });

  it("rejects a Document attachment with no url", () => {
    const result = runActivityStreamsStructureCheck({
      type: "Create",
      actor: "https://a.example/x",
      object: {
        type: "Note",
        attributedTo: "https://a.example/x",
        attachment: [{ type: "Document", mediaType: "image/png" }],
      },
    });
    expect(result.outcome).toBe("rejected_parse");
  });

  it("tolerates unrecognized extension properties without inspecting them", () => {
    const result = runActivityStreamsStructureCheck({
      type: "Create",
      actor: "https://a.example/x",
      object: { type: "Note", attributedTo: "https://a.example/x", quoteUri: "https://a.example/quoted" },
    });
    expect(result.outcome).toBe("tolerant_accept");
  });

  it("rejects a non-object payload", () => {
    expect(runActivityStreamsStructureCheck("not an object").outcome).toBe("rejected_parse");
    expect(runActivityStreamsStructureCheck(null).outcome).toBe("rejected_parse");
  });
});

describe("runAuthorityPolicyCheck", () => {
  it("accepts an Accept issued by the actual target of the embedded Follow", () => {
    const result = runAuthorityPolicyCheck({
      type: "Accept",
      actor: "https://a.example/bob",
      object: { type: "Follow", actor: "https://a.example/alice", object: "https://a.example/bob" },
    });
    expect(result.outcome).toBe("tolerant_accept");
  });

  it("rejects an Accept issued by someone who was not the target of the embedded Follow", () => {
    const result = runAuthorityPolicyCheck({
      type: "Accept",
      actor: "https://a.example/carol",
      object: { type: "Follow", actor: "https://a.example/alice", object: "https://a.example/bob" },
    });
    expect(result.outcome).toBe("rejected_authority");
  });

  it("does not authority-check a bare-IRI Accept.object", () => {
    const result = runAuthorityPolicyCheck({
      type: "Accept",
      actor: "https://a.example/carol",
      object: "https://a.example/some-follow",
    });
    expect(result.outcome).toBe("tolerant_accept");
  });

  it("passes through structural rejections unchanged", () => {
    const result = runAuthorityPolicyCheck({ type: "Accept" });
    expect(result.outcome).toBe("rejected_parse");
  });
});

describe("runReplayIdempotencyCheck", () => {
  it("applies the first delivery and no-ops every subsequent identical delivery", () => {
    const ledger = new Set<string>();
    const payload = { id: "https://a.example/activities/1", type: "Create", actor: "https://a.example/x", object: { type: "Note", attributedTo: "https://a.example/x" } };

    const first = runReplayIdempotencyCheck(payload, ledger);
    expect(first.outcome).toBe("tolerant_accept");

    const second = runReplayIdempotencyCheck(payload, ledger);
    expect(second.outcome).toBe("idempotent_replay_noop");

    const third = runReplayIdempotencyCheck(payload, ledger);
    expect(third.outcome).toBe("idempotent_replay_noop");
  });

  it("rejects a payload with no id as undeduplicable", () => {
    const result = runReplayIdempotencyCheck(
      { type: "Create", actor: "https://a.example/x", object: { type: "Note", attributedTo: "https://a.example/x" } },
      new Set(),
    );
    expect(result.outcome).toBe("rejected_parse");
  });

  it("keeps separate activity ids independent in the same ledger", () => {
    const ledger = new Set<string>();
    const a = { id: "https://a.example/activities/a", type: "Follow", actor: "https://a.example/x", object: "https://a.example/y" };
    const b = { id: "https://a.example/activities/b", type: "Follow", actor: "https://a.example/x", object: "https://a.example/y" };
    expect(runReplayIdempotencyCheck(a, ledger).outcome).toBe("tolerant_accept");
    expect(runReplayIdempotencyCheck(b, ledger).outcome).toBe("tolerant_accept");
    expect(runReplayIdempotencyCheck(a, ledger).outcome).toBe("idempotent_replay_noop");
  });
});
