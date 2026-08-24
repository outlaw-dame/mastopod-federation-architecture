import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AP_INTEROP_FIXTURES, assertFixtureSiblingCoverage } from "./FixtureCorpus.js";
import { FixtureMetadataSchema, type FixtureMetadata } from "./FixtureMetadata.js";
import {
  runActivityStreamsStructureCheck,
  runAuthorityPolicyCheck,
  runReplayIdempotencyCheck,
  type BoundaryRunResult,
} from "./FixtureBoundaryRunner.js";

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "interop", "ap", "fixtures");

function loadPayload(fixture: FixtureMetadata): unknown {
  const absolutePath = join(FIXTURES_ROOT, fixture.relativeFixturePath);
  return JSON.parse(readFileSync(absolutePath, "utf-8"));
}

/**
 * Feeds a fixture's payload through the boundary its own metadata declares as the one that
 * decides its outcome, so `expectedOutcome` is checked against real (if hermetic) processing
 * rather than only against JSON syntax. `target_persistence` fixtures are delivered twice
 * against a fresh ledger and the *second* delivery's outcome is what's asserted, since replay
 * fixtures are specifically about what happens to the re-delivery.
 */
function runDeclaredBoundary(fixture: FixtureMetadata, payload: unknown): BoundaryRunResult {
  const boundaries = new Set(fixture.boundariesExercised);
  if (boundaries.has("authority_policy")) {
    return runAuthorityPolicyCheck(payload);
  }
  if (boundaries.has("target_persistence")) {
    const ledger = new Set<string>();
    runReplayIdempotencyCheck(payload, ledger);
    return runReplayIdempotencyCheck(payload, ledger);
  }
  return runActivityStreamsStructureCheck(payload);
}

describe("AP_INTEROP_FIXTURES", () => {
  it("has every entry valid against FixtureMetadataSchema", () => {
    for (const fixture of AP_INTEROP_FIXTURES) {
      expect(() => FixtureMetadataSchema.parse(fixture)).not.toThrow();
    }
  });

  it("does not throw on module-load sibling-coverage assertion", () => {
    expect(() => assertFixtureSiblingCoverage()).not.toThrow();
  });

  it("has a real, parseable JSON payload on disk at every relativeFixturePath", () => {
    for (const fixture of AP_INTEROP_FIXTURES) {
      expect(() => loadPayload(fixture)).not.toThrow();
    }
  });

  it("resolves every fixture's declared boundary to its declared expectedOutcome", () => {
    for (const fixture of AP_INTEROP_FIXTURES) {
      const payload = loadPayload(fixture);
      const result = runDeclaredBoundary(fixture, payload);
      expect(result.outcome, `${fixture.fixtureId}: ${result.reason ?? "no reason given"}`).toBe(
        fixture.expectedOutcome,
      );
    }
  });

  it("rejects the forged Accept for real: it is structurally valid but authority-fails", () => {
    const fixture = AP_INTEROP_FIXTURES.find((f) => f.fixtureId === "mastodon.forged-accept-mismatched-follow");
    expect(fixture).toBeDefined();
    const payload = loadPayload(fixture!);

    // Structural check alone must NOT reject it — that's the whole point of the fixture.
    expect(runActivityStreamsStructureCheck(payload).outcome).toBe("tolerant_accept");
    // The authority-aware check must reject it.
    expect(runAuthorityPolicyCheck(payload).outcome).toBe("rejected_authority");
  });

  it("treats the second delivery of the replay fixture as a no-op, not a duplicate application", () => {
    const fixture = AP_INTEROP_FIXTURES.find((f) => f.fixtureId === "gotosocial.create-duplicate-delivery-replay");
    expect(fixture).toBeDefined();
    const payload = loadPayload(fixture!);
    const ledger = new Set<string>();

    expect(runReplayIdempotencyCheck(payload, ledger).outcome).toBe("tolerant_accept");
    expect(runReplayIdempotencyCheck(payload, ledger).outcome).toBe("idempotent_replay_noop");
  });

  it("preserves unrecognized extension terms on permissible_variation fixtures instead of stripping them", () => {
    const quote = AP_INTEROP_FIXTURES.find((f) => f.fixtureId === "mastodon.note-quote-extension-permissible");
    const blurhash = AP_INTEROP_FIXTURES.find((f) => f.fixtureId === "gotosocial.note-blurhash-attachment-permissible");
    expect(quote).toBeDefined();
    expect(blurhash).toBeDefined();

    const quotePayload = loadPayload(quote!) as { object: { quoteUri?: string } };
    expect(quotePayload.object.quoteUri).toBeTruthy();
    expect(runActivityStreamsStructureCheck(quotePayload).outcome).toBe("tolerant_accept");

    const blurhashPayload = loadPayload(blurhash!) as { object: { attachment: Array<{ blurhash?: string }> } };
    expect(blurhashPayload.object.attachment[0]?.blurhash).toBeTruthy();
    expect(runActivityStreamsStructureCheck(blurhashPayload).outcome).toBe("tolerant_accept");
  });

  it("has no fixture claiming real user content", () => {
    for (const fixture of AP_INTEROP_FIXTURES) {
      expect(fixture.redaction.containsRealUserContent).toBe(false);
    }
  });

  it("gives every permissible_variation family at least one malformed/adversarial sibling", () => {
    const byFamily = new Map<string, Set<string>>();
    for (const fixture of AP_INTEROP_FIXTURES) {
      const key = `${fixture.targetId}::${fixture.capability}`;
      const dispositions = byFamily.get(key) ?? new Set<string>();
      dispositions.add(fixture.disposition);
      byFamily.set(key, dispositions);
    }

    for (const [family, dispositions] of byFamily) {
      if (!dispositions.has("permissible_variation")) continue;
      const hasSibling = ["malformed_structure", "unsafe_authority_bypass_attempt", "adversarial_replay", "adversarial_duplicate"]
        .some((d) => dispositions.has(d));
      expect(hasSibling, `family ${family} needs a malformed/adversarial sibling`).toBe(true);
    }
  });

  it("throws when a permissible_variation fixture's only sibling is dropped", () => {
    const withoutSibling = AP_INTEROP_FIXTURES.filter(
      (f) => f.fixtureId !== "mastodon.note-missing-actor-malformed",
    );
    expect(() => assertFixtureSiblingCoverage(withoutSibling)).toThrow(/mastodon::note/);
  });

  it("throws on a duplicate fixtureId", () => {
    const [first] = AP_INTEROP_FIXTURES;
    expect(first).toBeDefined();
    const duplicated = [...AP_INTEROP_FIXTURES, first!];
    expect(() => assertFixtureSiblingCoverage(duplicated)).toThrow(/duplicate fixture id/);
  });

  it("does not throw for an adversarial-only family with no permissible counterpart", () => {
    const adversarialOnly = AP_INTEROP_FIXTURES.filter((f) => f.targetId === "akkoma");
    expect(() => assertFixtureSiblingCoverage(adversarialOnly)).not.toThrow();
  });
});
