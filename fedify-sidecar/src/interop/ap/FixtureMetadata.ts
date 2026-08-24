import { z } from "zod";
import { getInteropTarget } from "./InteropTargetRegistry.js";
import { AssertionBoundarySchema, VisibilityClassSchema } from "./SemanticInteropAssertion.js";

/**
 * Fixture metadata + redaction-rule contract for ACTIVITYPUB-INTEROPERABILITY-HARDENING.md
 * deliverable 3 ("Add fixture metadata/schema and redaction rules").
 *
 * This schema governs the *record describing a fixture*, not the raw ActivityPub payload
 * itself. Every file under `fedify-sidecar/interop/ap/fixtures/<targetId>/` that is used as
 * CI-executable interoperability evidence must have a corresponding metadata object that
 * validates against `FixtureMetadataSchema` before the fixture is trusted by a test.
 *
 * The redaction rules are encoded as schema invariants, not just prose, so a fixture that
 * violates them fails to parse rather than silently landing in the corpus.
 */
export const AP_INTEROP_FIXTURE_SCHEMA_VERSION = "ap-interop-fixture-v1" as const;

/**
 * Where a fixture's shape actually came from. `live_capture` and `hybrid_reduced` fixtures
 * originate from a real remote implementation's wire output (via BrowserPub or direct
 * inspection) and are therefore subject to the redaction requirements below. `synthetic`
 * fixtures are hand-authored to represent a known dialect/edge case and never touched real
 * traffic, so provenance/redaction fields narrow accordingly (see superRefine).
 */
export const FixtureSourceClassSchema = z.enum([
  "live_capture",
  "hybrid_reduced",
  "synthetic",
]);

/**
 * What the fixture is exercising, per the hardening doc's "Required harness properties":
 * - permissible_variation: valid-but-unusual real-world shape that must be tolerantly parsed.
 * - malformed_structure: structurally invalid input that must be rejected at the parser layer.
 * - unsafe_authority_bypass_attempt: a structurally parseable input that attempts to smuggle
 *   authority/visibility/addressing it should not have; must be rejected at the authority or
 *   visibility boundary, never merely "tolerated" by relaxing parsing.
 * - adversarial_replay / adversarial_duplicate: re-delivery or duplicate-activity cases that
 *   must resolve idempotently.
 */
export const FixtureDispositionSchema = z.enum([
  "permissible_variation",
  "malformed_structure",
  "unsafe_authority_bypass_attempt",
  "adversarial_replay",
  "adversarial_duplicate",
]);

/**
 * The fixture-level expected result. This is deliberately coarser than
 * `SemanticOutcomeSchema` in SemanticInteropAssertion.ts (which records what an assertion
 * *observed*) — this records what a fixture author *expects* a correct implementation to do,
 * so CI can fail closed when a fixture's own disposition and expected outcome disagree.
 */
export const FixtureExpectedOutcomeSchema = z.enum([
  "tolerant_accept",
  "ignored_extension",
  "rejected_parse",
  "rejected_authority",
  "rejected_visibility",
  "idempotent_replay_noop",
]);

const OUTCOMES_REQUIRING_REJECTION = new Set<z.infer<typeof FixtureExpectedOutcomeSchema>>([
  "rejected_parse",
  "rejected_authority",
  "rejected_visibility",
]);

const OUTCOMES_PERMITTING_TOLERANCE = new Set<z.infer<typeof FixtureExpectedOutcomeSchema>>([
  "tolerant_accept",
  "ignored_extension",
]);

/**
 * Redaction record. Every field here exists to make "private/followers-only/direct data must
 * not be harvested into public fixture corpora" and "remote object IDs and actor IDs should
 * be synthetic unless identity is materially necessary" (ACTIVITYPUB-INTEROPERABILITY-
 * HARDENING.md, Security and privacy invariants) enforceable rather than aspirational.
 */
const FixtureRedactionSchema = z.object({
  /**
   * Hard fail-closed gate: a fixture metadata record can only ever assert `false` here. There
   * is intentionally no way to construct a valid FixtureMetadata that admits real user
   * content — if a captured fixture has not been scrubbed yet, it is not eligible to become a
   * fixture, full stop.
   */
  containsRealUserContent: z.literal(false),
  /** Visibility class the fixture represents structurally (public/unlisted/followers/...). */
  visibilityClassRepresented: VisibilityClassSchema,
  /**
   * Whether actor/object IRIs in the fixture are synthetic (`*.example` / harness-owned
   * identifiers) or a real, identifiable remote resource. Real identity is the exception and
   * must be justified.
   */
  identifierScheme: z.enum(["synthetic_example_domain", "real_identity_justified"]),
  identityJustificationNote: z.string().min(1).optional(),
  /** True once captured response headers were pruned to only schema-relevant fields. */
  capturedResponseHeadersRedacted: z.boolean(),
  /** ISO-8601 date; required for live_capture/hybrid_reduced, forbidden for synthetic. */
  sourceCaptureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Implementation/version/media-type provenance note (workflow step 4). */
  sourceCaptureNote: z.string().min(1).optional(),
}).strict();

export const FixtureMetadataSchema = z.object({
  schemaVersion: z.literal(AP_INTEROP_FIXTURE_SCHEMA_VERSION),
  fixtureId: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
  targetId: z.string().min(1),
  /** Governed capability (must be one the target's InteropTargetRegistry entry declares). */
  capability: z.string().min(1),
  softwareVersion: z.string().min(1),
  sourceClass: FixtureSourceClassSchema,
  disposition: FixtureDispositionSchema,
  expectedOutcome: FixtureExpectedOutcomeSchema,
  /** Which SemanticInteropAssertion boundaries this fixture is meant to exercise. */
  boundariesExercised: z.array(AssertionBoundarySchema).min(1),
  /**
   * Relative path from `fedify-sidecar/interop/ap/fixtures/`, e.g.
   * `mastodon/note-quote-permissible-variation.json`. Enforces the directory-per-target
   * convention rather than letting fixtures scatter under one flat folder.
   */
  relativeFixturePath: z.string().regex(/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*\.(json|jsonld)$/),
  redaction: FixtureRedactionSchema,
  /**
   * BrowserPub-to-regression workflow step 7 classification. Required for anything that
   * originated from a real observed difference (i.e. not a purely synthetic authored case).
   */
  regressionClassification: z
    .enum(["transport_authority", "parsing", "semantic_normalization", "authorization_visibility", "app_presentation"])
    .optional(),
  notes: z.array(z.string().min(1)).default([]),
}).strict().superRefine((value, ctx) => {
  const governedTarget = getInteropTarget(value.targetId);

  if (!governedTarget || governedTarget.id !== value.targetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetId"],
      message: "targetId must be a canonical governed ActivityPub interoperability target id",
    });
  } else if (!governedTarget.capabilities.includes(value.capability)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capability"],
      message: `capability must be declared by governed target ${governedTarget.id}: ${governedTarget.capabilities.join(", ")}`,
    });
  }

  const [pathTargetSegment] = value.relativeFixturePath.split("/");
  if (pathTargetSegment !== value.targetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relativeFixturePath"],
      message: "relativeFixturePath's first directory segment must equal targetId",
    });
  }

  // --- Redaction rules ---

  if (
    value.redaction.identifierScheme === "real_identity_justified" &&
    !value.redaction.identityJustificationNote
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction", "identityJustificationNote"],
      message: "real, identifiable remote identity requires a non-empty justification note",
    });
  }

  if (value.sourceClass === "synthetic") {
    if (value.redaction.sourceCaptureDate || value.redaction.sourceCaptureNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction"],
        message: "synthetic fixtures must not carry live-capture provenance fields",
      });
    }
  } else if (!value.redaction.sourceCaptureDate || !value.redaction.sourceCaptureNote) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction"],
      message: "live_capture/hybrid_reduced fixtures require sourceCaptureDate and sourceCaptureNote",
    });
  }

  // --- Disposition <-> expected-outcome agreement ---
  // "malformed/unsafe variants prove rejection at the correct boundary; permissible variation
  // proves tolerant parsing/normalization" (ACTIVITYPUB-INTEROPERABILITY-HARDENING.md).

  if (
    (value.disposition === "malformed_structure" || value.disposition === "unsafe_authority_bypass_attempt") &&
    !OUTCOMES_REQUIRING_REJECTION.has(value.expectedOutcome)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedOutcome"],
      message: `disposition ${value.disposition} must expect a rejected_* outcome`,
    });
  }

  if (value.disposition === "permissible_variation" && !OUTCOMES_PERMITTING_TOLERANCE.has(value.expectedOutcome)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedOutcome"],
      message: "disposition permissible_variation must expect tolerant_accept or ignored_extension",
    });
  }

  if (
    (value.disposition === "adversarial_replay" || value.disposition === "adversarial_duplicate") &&
    value.expectedOutcome !== "idempotent_replay_noop"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedOutcome"],
      message: `disposition ${value.disposition} must expect idempotent_replay_noop`,
    });
  }

  // An authority-bypass adversarial case that only exercises parsing boundaries would prove
  // nothing about authority enforcement — it must actually reach an authority-bearing
  // boundary, never make parsing pass and stop there.
  if (value.disposition === "unsafe_authority_bypass_attempt") {
    const boundaries = new Set(value.boundariesExercised);
    const reachesAuthorityBoundary =
      boundaries.has("authority_policy") ||
      boundaries.has("visibility_privacy") ||
      boundaries.has("wire_authentication");
    if (!reachesAuthorityBoundary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boundariesExercised"],
        message:
          "unsafe_authority_bypass_attempt must exercise an authority-bearing boundary (authority_policy, visibility_privacy, or wire_authentication), not parsing alone",
      });
    }
  }

  if (value.regressionClassification === undefined && value.sourceClass !== "synthetic") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["regressionClassification"],
      message: "fixtures derived from a real observed difference require a regressionClassification",
    });
  }
});

export type FixtureMetadata = z.infer<typeof FixtureMetadataSchema>;

export function parseFixtureMetadata(input: unknown): FixtureMetadata {
  return FixtureMetadataSchema.parse(input);
}

export function isFixtureMetadata(input: unknown): input is FixtureMetadata {
  return FixtureMetadataSchema.safeParse(input).success;
}
