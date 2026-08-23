import { describe, expect, it } from "vitest";
import type { InboundEnvelope } from "./sidecar-redis-queue-core.js";
import { stripUnverifiedSyntheticVerification } from "./sidecar-redis-queue.js";

function envelope(headers: Record<string, string>): InboundEnvelope {
  return {
    envelopeId: "env-1",
    method: "POST",
    path: "/inbox",
    headers,
    body: JSON.stringify({
      type: "Create",
      actor: "https://remote.example/users/alice",
      object: { type: "Note", id: "https://remote.example/notes/1" },
    }),
    remoteIp: "127.0.0.1",
    receivedAt: Date.now(),
    attempt: 0,
    notBeforeMs: 0,
    verification: {
      source: "fedify-v2",
      actorUri: "https://remote.example/users/alice",
      verifiedAt: Date.now(),
    },
  };
}

describe("stripUnverifiedSyntheticVerification", () => {
  it("removes the overloaded preverified marker from origin reconciliation", () => {
    const result = stripUnverifiedSyntheticVerification(
      envelope({ "x-origin-reconciliation": "true" }),
    );
    expect(result.verification).toBeUndefined();
  });

  it("removes the overloaded preverified marker from replies backfill", () => {
    const result = stripUnverifiedSyntheticVerification(
      envelope({ "x-backfill-source": "replies-collection" }),
    );
    expect(result.verification).toBeUndefined();
  });

  it("removes wire-verification trust from authenticated benchmark injection", () => {
    const result = stripUnverifiedSyntheticVerification(
      envelope({ "x-sidecar-benchmark": "1" }),
    );
    expect(result.verification).toBeUndefined();
  });

  it("preserves genuine Fedify wire verification metadata", () => {
    const original = envelope({ "content-type": "application/activity+json" });
    const result = stripUnverifiedSyntheticVerification(original);
    expect(result).toBe(original);
    expect(result.verification?.source).toBe("fedify-v2");
  });
});