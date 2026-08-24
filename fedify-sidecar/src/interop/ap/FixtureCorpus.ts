import { AP_INTEROP_FIXTURE_SCHEMA_VERSION, FixtureMetadataSchema, type FixtureMetadata } from "./FixtureMetadata.js";

/**
 * Seed fixture corpus for ACTIVITYPUB-INTEROPERABILITY-HARDENING.md ordered deliverable 5
 * ("Add malformed/adversarial sibling cases for every permissive fixture family").
 *
 * This is the deterministic "empirical dialect fixtures" CI lane (the hardening doc's CI
 * lane 3), distinct from the live-container matrix in PR #106 (lane 4, "cross-implementation
 * live smoke" — optional/scheduled, never the only proof). It is deliberately a small
 * representative seed, not a large corpus (per the hardening doc's ordering: seed first,
 * expand later).
 *
 * Every entry here is `sourceClass: "synthetic"` — hand-authored to represent a known,
 * documented dialect or failure mode, not captured from live traffic in this session. That is
 * an honest provenance claim, not a placeholder: FixtureMetadataSchema forbids synthetic
 * fixtures from carrying live-capture provenance fields, so there is no way for one of these
 * to silently misrepresent itself as a real capture later.
 */
export const AP_INTEROP_FIXTURES: readonly FixtureMetadata[] = [
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "mastodon.note-quote-extension-permissible",
    targetId: "mastodon",
    capability: "note",
    softwareVersion: "v4.5.x-dialect",
    sourceClass: "synthetic",
    disposition: "permissible_variation",
    expectedOutcome: "tolerant_accept",
    boundariesExercised: ["activitystreams_structure", "jsonld_semantics"],
    relativeFixturePath: "mastodon/note-quote-extension-permissible.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "semantic_normalization",
    notes: [
      "Represents the Fedibird/Mastodon-family quoteUri extension term on a Note.",
      "Sibling: mastodon.note-missing-actor-malformed.",
    ],
  },
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "mastodon.note-missing-actor-malformed",
    targetId: "mastodon",
    capability: "note",
    softwareVersion: "v4.5.x-dialect",
    sourceClass: "synthetic",
    disposition: "malformed_structure",
    expectedOutcome: "rejected_parse",
    boundariesExercised: ["activitystreams_structure"],
    relativeFixturePath: "mastodon/note-missing-actor-malformed.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "parsing",
    notes: ["A Create activity with no top-level actor is structurally invalid ActivityPub and must be rejected at the parser layer, not defaulted or inferred from the embedded object's attributedTo."],
  },
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "mastodon.follow-actor-array-form-permissible",
    targetId: "mastodon",
    capability: "follow",
    softwareVersion: "v4.5.x-dialect",
    sourceClass: "synthetic",
    disposition: "permissible_variation",
    expectedOutcome: "tolerant_accept",
    boundariesExercised: ["activitystreams_structure"],
    relativeFixturePath: "mastodon/follow-actor-array-form-permissible.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "parsing",
    notes: [
      "actor expressed as a single-element array is a valid JSON-LD compaction form, not a distinct semantic claim.",
      "Sibling: mastodon.follow-missing-object-malformed.",
    ],
  },
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "mastodon.follow-missing-object-malformed",
    targetId: "mastodon",
    capability: "follow",
    softwareVersion: "v4.5.x-dialect",
    sourceClass: "synthetic",
    disposition: "malformed_structure",
    expectedOutcome: "rejected_parse",
    boundariesExercised: ["activitystreams_structure"],
    relativeFixturePath: "mastodon/follow-missing-object-malformed.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "parsing",
    notes: ["object is required on Follow; a Follow without one names nothing to follow and must be rejected."],
  },
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "mastodon.forged-accept-mismatched-follow",
    targetId: "mastodon",
    capability: "accept",
    softwareVersion: "v4.5.x-dialect",
    sourceClass: "synthetic",
    disposition: "unsafe_authority_bypass_attempt",
    expectedOutcome: "rejected_authority",
    boundariesExercised: ["activitystreams_structure", "authority_policy"],
    relativeFixturePath: "mastodon/forged-accept-mismatched-follow.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "direct",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "authorization_visibility",
    notes: [
      "carol issues an Accept embedding a real-shaped Follow(alice -> bob) that carol was never party to.",
      "A structurally-valid embedded Follow must not be sufficient; the accepting actor's own authority over that Follow must be checked and must fail here.",
      "No permissible_variation sibling in this (mastodon, accept) family, so no pairing requirement applies to it.",
    ],
  },
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "gotosocial.note-blurhash-attachment-permissible",
    targetId: "gotosocial",
    capability: "note",
    softwareVersion: "0.1x-dialect",
    sourceClass: "synthetic",
    disposition: "permissible_variation",
    expectedOutcome: "tolerant_accept",
    boundariesExercised: ["activitystreams_structure", "jsonld_semantics"],
    relativeFixturePath: "gotosocial/note-blurhash-attachment-permissible.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "semantic_normalization",
    notes: [
      "toot:blurhash on a Document attachment is a widely-deployed Mastodon-namespace extension, not GoToSocial-specific, but exercised here under the gotosocial target.",
      "Sibling: gotosocial.create-duplicate-delivery-replay.",
    ],
  },
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "gotosocial.create-duplicate-delivery-replay",
    targetId: "gotosocial",
    capability: "note",
    softwareVersion: "0.1x-dialect",
    sourceClass: "synthetic",
    disposition: "adversarial_replay",
    expectedOutcome: "idempotent_replay_noop",
    boundariesExercised: ["activitystreams_structure", "target_persistence"],
    relativeFixturePath: "gotosocial/create-duplicate-delivery-replay.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "transport_authority",
    notes: ["Deliver this identical activity id twice; the second delivery must be a no-op, not a duplicate Note or a duplicate side effect."],
  },
  {
    schemaVersion: AP_INTEROP_FIXTURE_SCHEMA_VERSION,
    fixtureId: "akkoma.note-attachment-missing-url-malformed",
    targetId: "akkoma",
    capability: "media",
    softwareVersion: "v3.18.x-dialect",
    sourceClass: "synthetic",
    disposition: "malformed_structure",
    expectedOutcome: "rejected_parse",
    boundariesExercised: ["activitystreams_structure"],
    relativeFixturePath: "akkoma/note-attachment-missing-url-malformed.json",
    redaction: {
      containsRealUserContent: false,
      visibilityClassRepresented: "public",
      identifierScheme: "synthetic_example_domain",
      capturedResponseHeadersRedacted: true,
    },
    regressionClassification: "parsing",
    notes: [
      "A Document attachment with no url is not retrievable and must be rejected or dropped at the attachment layer, not silently rendered as an empty/broken media item.",
      "No permissible_variation sibling in this (akkoma, media) family, so no pairing requirement applies to it.",
    ],
  },
] as const;

/**
 * Enforces deliverable 5 itself: every fixture family (targetId + capability) that contains a
 * `permissible_variation` case must also contain at least one malformed/adversarial sibling in
 * that same family. This runs at module load, the same fail-closed posture
 * `InteropTargetRegistry.ts` takes for its own invariants — a future fixture that adds a new
 * permissive case without a sibling breaks the build rather than silently landing uncovered.
 */
export function assertFixtureSiblingCoverage(fixtures: readonly FixtureMetadata[] = AP_INTEROP_FIXTURES): void {
  const seenFixtureIds = new Set<string>();
  const seenPaths = new Set<string>();
  const familyDispositions = new Map<string, Set<FixtureMetadata["disposition"]>>();

  for (const fixture of fixtures) {
    FixtureMetadataSchema.parse(fixture);

    if (seenFixtureIds.has(fixture.fixtureId)) {
      throw new Error(`duplicate fixture id: ${fixture.fixtureId}`);
    }
    seenFixtureIds.add(fixture.fixtureId);

    if (seenPaths.has(fixture.relativeFixturePath)) {
      throw new Error(`duplicate fixture relativeFixturePath: ${fixture.relativeFixturePath}`);
    }
    seenPaths.add(fixture.relativeFixturePath);

    const familyKey = `${fixture.targetId}::${fixture.capability}`;
    const dispositions = familyDispositions.get(familyKey) ?? new Set();
    dispositions.add(fixture.disposition);
    familyDispositions.set(familyKey, dispositions);
  }

  const siblingDispositions: ReadonlySet<FixtureMetadata["disposition"]> = new Set([
    "malformed_structure",
    "unsafe_authority_bypass_attempt",
    "adversarial_replay",
    "adversarial_duplicate",
  ]);

  for (const [familyKey, dispositions] of familyDispositions) {
    if (!dispositions.has("permissible_variation")) {
      continue;
    }
    const hasSibling = [...dispositions].some((disposition) => siblingDispositions.has(disposition));
    if (!hasSibling) {
      throw new Error(
        `fixture family ${familyKey} has a permissible_variation case but no malformed/adversarial sibling`,
      );
    }
  }
}

assertFixtureSiblingCoverage();
