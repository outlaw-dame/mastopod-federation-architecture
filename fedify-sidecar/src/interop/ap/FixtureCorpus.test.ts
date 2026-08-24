import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AP_INTEROP_FIXTURES, assertFixtureSiblingCoverage } from "./FixtureCorpus.js";
import { FixtureMetadataSchema } from "./FixtureMetadata.js";

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "interop", "ap", "fixtures");

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
      const absolutePath = join(FIXTURES_ROOT, fixture.relativeFixturePath);
      const raw = readFileSync(absolutePath, "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    }
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
