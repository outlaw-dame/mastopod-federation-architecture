import { describe, expect, it } from "vitest";
import {
  normalizeControlledTargetStatsUrl,
  parseControlledTargetSnapshot,
} from "../ControlledTargetSnapshotClient.js";

function validSnapshot() {
  return {
    version: 1,
    transientFailuresBeforeSuccess: 2,
    maxObservations: 100,
    totalRequests: 1,
    droppedObservations: 0,
    counts: { success: 1, transient: 0, permanent: 0 },
    observations: [
      {
        sequence: 1,
        scenario: "success",
        scenarioAttempt: 1,
        payloadAttempt: 1,
        method: "POST",
        path: "/inbox/success",
        bodyBytes: 17,
        bodySha256: "a".repeat(64),
        activityId: "https://pods.example/activities/1",
        contentType: "application/activity+json",
        host: "127.0.0.1:18080",
        hasDate: true,
        hasDigest: true,
        hasValidDigest: true,
        hasSignature: true,
        receivedAtMs: 1_000,
      },
    ],
  };
}

describe("controlled target snapshot hardening", () => {
  it("accepts only explicit loopback HTTP /stats URLs", () => {
    expect(normalizeControlledTargetStatsUrl("http://127.0.0.1:18080/stats").href)
      .toBe("http://127.0.0.1:18080/stats");
    expect(normalizeControlledTargetStatsUrl("http://localhost:18080/stats").hostname)
      .toBe("localhost");

    for (const invalid of [
      "https://127.0.0.1:18080/stats",
      "http://10.0.0.5:18080/stats",
      "http://example.com/stats",
      "http://user:pass@127.0.0.1:18080/stats",
      "http://127.0.0.1:18080/other",
      "http://127.0.0.1:18080/stats#fragment",
    ]) {
      expect(() => normalizeControlledTargetStatsUrl(invalid)).toThrow();
    }
  });

  it("parses the exact controlled-target snapshot shape", () => {
    expect(parseControlledTargetSnapshot(validSnapshot())).toEqual(validSnapshot());
  });

  it("rejects numeric strings rather than coercing benchmark evidence", () => {
    const snapshot = validSnapshot() as any;
    snapshot.maxObservations = "100";
    expect(() => parseControlledTargetSnapshot(snapshot)).toThrow(/maxObservations/u);

    const second = validSnapshot() as any;
    second.counts.success = "1";
    expect(() => parseControlledTargetSnapshot(second)).toThrow(/counts.success/u);
  });

  it("rejects aggregate counts that do not equal totalRequests", () => {
    const snapshot = validSnapshot();
    snapshot.counts.transient = 1;
    expect(() => parseControlledTargetSnapshot(snapshot)).toThrow(/count mismatch/u);
  });

  it("rejects retained plus dropped observation counts that do not reconcile", () => {
    const snapshot = validSnapshot();
    snapshot.droppedObservations = 1;
    expect(() => parseControlledTargetSnapshot(snapshot)).toThrow(/retained\/dropped/u);
  });

  it("rejects malformed observation fields and unknown scenarios", () => {
    const snapshot = validSnapshot() as any;
    snapshot.observations[0].scenario = "other";
    expect(() => parseControlledTargetSnapshot(snapshot)).toThrow(/scenario is invalid/u);

    const second = validSnapshot() as any;
    second.observations[0].hasSignature = "yes";
    expect(() => parseControlledTargetSnapshot(second)).toThrow(/hasSignature must be boolean/u);

    const third = validSnapshot() as any;
    third.observations[0].hasValidDigest = "yes";
    expect(() => parseControlledTargetSnapshot(third)).toThrow(/hasValidDigest must be boolean/u);
  });

  it("accepts null Activity identity only as explicit unknown and rejects malformed strings", () => {
    const unknown = validSnapshot();
    unknown.observations[0]!.activityId = null as any;
    expect(parseControlledTargetSnapshot(unknown).observations[0]?.activityId).toBeNull();

    const padded = validSnapshot() as any;
    padded.observations[0].activityId = " padded ";
    expect(() => parseControlledTargetSnapshot(padded)).toThrow(/activityId/u);

    const wrongType = validSnapshot() as any;
    wrongType.observations[0].activityId = 42;
    expect(() => parseControlledTargetSnapshot(wrongType)).toThrow(/activityId/u);
  });
});
