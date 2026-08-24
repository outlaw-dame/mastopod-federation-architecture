import { describe, expect, it } from "vitest";
import {
  AP_INTEROP_FIXTURE_SCHEMA_VERSION,
  FixtureMetadataSchema,
  type FixtureMetadata,
} from "./FixtureMetadata.js";

function baseFixture(overrides: Partial<FixtureMetadata> = {}): FixtureMetadata {
  return {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "mastodon.note-quote-permissible-variation",
    targetId: "mastodon",
    capability: "note",
    softwareVersion: "v4.5.8",
    sourceClass: "live_capture",
    disposition: "permissible_variation",
    expectedOutcome: "tolerant_accept",
    boundariesExercised: ["activitystreams_structure", "jsonld_semantics"],
    relativeFixturePath: "mastodon/note-quote-permissible-variation.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
      sourceCaptureDate: "2026-08-24",
      sourceCaptureNote: "Mastodon v4.5.8 quote-post shape, content-type application/activity+json",
    },
    regressionClassification: "semantic_normalization",
    notes: [],
    ...overrides,
  };
}

describe("FixtureMetadataSchema", () => {
  it("accepts a well-formed live-capture permissible-variation fixture", () => {
    expect(FixtureMetadataSchema.parse(baseFixture())).toBeTruthy();
  });

  it("rejects an unrecognized targetId", () => {
    expect(() => FixtureMetadataSchema.parse(baseFixture({ targetId: "not-a-real-target" }))).toThrow();
  });

  it("rejects a capability the governed target does not declare", () => {
    expect(() => FixtureMetadataSchema.parse(baseFixture({ capability: "quantum_teleport" }))).toThrow();
  });

  it("rejects relativeFixturePath whose directory segment does not match targetId", () => {
    expect(() =>
      FixtureMetadataSchema.parse(
        baseFixture({ relativeFixturePath: "akkoma/note-quote-permissible-variation.json" }),
      ),
    ).toThrow();
  });

  it("has no way to construct a fixture that admits real user content", () => {
    const withRealContent = {
      ...baseFixture(),
      redaction: { ...baseFixture().redaction, containsRealUserContent: true },
    };
    expect(() => FixtureMetadataSchema.parse(withRealContent)).toThrow();
  });

  it("requires a justification note when identity is claimed real rather than synthetic", () => {
    const unjustified = {
      ...baseFixture(),
      redaction: { ...baseFixture().redaction, identifierScheme: "real_identity_justified" as const },
    };
    expect(() => FixtureMetadataSchema.parse(unjustified)).toThrow();

    const justified = {
      ...baseFixture(),
      redaction: {
        ...baseFixture().redaction,
        identifierScheme: "real_identity_justified" as const,
        identityJustificationNote: "Regression requires the exact well-known relay actor IRI.",
      },
    };
    expect(FixtureMetadataSchema.parse(justified)).toBeTruthy();
  });

  it("rejects synthetic fixtures that carry live-capture provenance", () => {
    const contaminated = baseFixture({
      sourceClass: "synthetic",
      regressionClassification: undefined,
    });
    expect(() => FixtureMetadataSchema.parse(contaminated)).toThrow();
  });

  it("requires capture provenance for live_capture/hybrid_reduced fixtures", () => {
    const missingProvenance = {
      ...baseFixture(),
      redaction: {
        containsRealUserContent: false as const,
        visibilityClassRepresented: "public" as const,
        identifierScheme: "synthetic_example_domain" as const,
        capturedResponseHeadersRedacted: true,
      },
    };
    expect(() => FixtureMetadataSchema.parse(missingProvenance)).toThrow();
  });

  it("allows a synthetic fixture without capture provenance or regression classification", () => {
    const synthetic = baseFixture({
      sourceClass: "synthetic",
      regressionClassification: undefined,
      redaction: {
        containsRealUserContent: false,
        visibilityClassRepresented: "public",
        identifierScheme: "synthetic_example_domain",
        capturedResponseHeadersRedacted: true,
      },
    });
    expect(FixtureMetadataSchema.parse(synthetic)).toBeTruthy();
  });

  it("rejects malformed_structure fixtures that expect tolerant_accept", () => {
    expect(() =>
      FixtureMetadataSchema.parse(
        baseFixture({ disposition: "malformed_structure", expectedOutcome: "tolerant_accept" }),
      ),
    ).toThrow();
  });

  it("accepts malformed_structure fixtures that expect a rejected_* outcome", () => {
    expect(
      FixtureMetadataSchema.parse(
        baseFixture({
          fixtureId: "mastodon.malformed-actor-missing-inbox",
          relativeFixturePath: "mastodon/malformed-actor-missing-inbox.json",
          disposition: "malformed_structure",
          expectedOutcome: "rejected_parse",
        }),
      ),
    ).toBeTruthy();
  });

  it("rejects unsafe_authority_bypass_attempt fixtures that only exercise parsing boundaries", () => {
    expect(() =>
      FixtureMetadataSchema.parse(
        baseFixture({
          fixtureId: "mastodon.forged-audience-bypass",
          relativeFixturePath: "mastodon/forged-audience-bypass.json",
          disposition: "unsafe_authority_bypass_attempt",
          expectedOutcome: "rejected_visibility",
          boundariesExercised: ["activitystreams_structure"],
        }),
      ),
    ).toThrow();
  });

  it("accepts unsafe_authority_bypass_attempt fixtures that reach an authority-bearing boundary", () => {
    expect(
      FixtureMetadataSchema.parse(
        baseFixture({
          fixtureId: "mastodon.forged-audience-bypass",
          relativeFixturePath: "mastodon/forged-audience-bypass.json",
          disposition: "unsafe_authority_bypass_attempt",
          expectedOutcome: "rejected_visibility",
          boundariesExercised: ["activitystreams_structure", "visibility_privacy"],
        }),
      ),
    ).toBeTruthy();
  });

  it("requires idempotent_replay_noop for adversarial replay/duplicate fixtures", () => {
    expect(() =>
      FixtureMetadataSchema.parse(
        baseFixture({
          fixtureId: "mastodon.duplicate-follow-replay",
          relativeFixturePath: "mastodon/duplicate-follow-replay.json",
          disposition: "adversarial_replay",
          expectedOutcome: "tolerant_accept",
        }),
      ),
    ).toThrow();

    expect(
      FixtureMetadataSchema.parse(
        baseFixture({
          fixtureId: "mastodon.duplicate-follow-replay",
          relativeFixturePath: "mastodon/duplicate-follow-replay.json",
          disposition: "adversarial_replay",
          expectedOutcome: "idempotent_replay_noop",
        }),
      ),
    ).toBeTruthy();
  });

  it("requires regressionClassification for non-synthetic fixtures", () => {
    expect(() =>
      FixtureMetadataSchema.parse(baseFixture({ regressionClassification: undefined })),
    ).toThrow();
  });
});
