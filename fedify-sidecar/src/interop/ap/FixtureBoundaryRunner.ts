import type { FixtureMetadata } from "./FixtureMetadata.js";

/**
 * Minimal, real, in-process ActivityPub boundary checks that fixture tests actually run
 * payloads through, in response to Codex review feedback on #109: a suite that only ran
 * `JSON.parse` on each fixture verified nothing about its declared `expectedOutcome` — the
 * forged Accept fixture could "pass" while asserting nothing about authority, and the replay
 * fixture could "pass" while asserting nothing about idempotency.
 *
 * Scope boundary, deliberately: this is a hermetic reference validator for proving the fixture
 * corpus's own claims are internally consistent and testable (the CI lane 3 "empirical dialect
 * fixtures" contract from ACTIVITYPUB-INTEROPERABILITY-HARDENING.md). It is not a replacement
 * for real authority enforcement. Per ADSP's own invariants, ActivityPods/SemApps owns
 * authoritative local ActivityPub planning/semantics, not this sidecar — and end-to-end proof
 * against real implementations remains PR #106's live-container matrix (CI lane 4). Nothing
 * here is wired into fedify-sidecar's production inbound path.
 */

export type BoundaryOutcome = FixtureMetadata["expectedOutcome"];

export interface BoundaryRunResult {
  outcome: BoundaryOutcome;
  reason?: string;
}

type JsonRecord = Record<string, unknown>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasValidActor(activity: JsonRecord): boolean {
  const actor = activity["actor"];
  if (isNonEmptyString(actor)) return true;
  return Array.isArray(actor) && actor.length > 0 && actor.every(isNonEmptyString);
}

function hasValidObjectReference(activity: JsonRecord): boolean {
  const object = activity["object"];
  if (object === undefined || object === null) return false;
  if (isNonEmptyString(object)) return true;
  return typeof object === "object";
}

/**
 * Exercises the `activitystreams_structure` boundary: the minimal ActivityPub required-field
 * rules this fixture corpus actually depends on (activity actor, Follow/Accept object,
 * Create/Update embedded-object shape, Document attachment retrievability). Unknown
 * properties (extension terms like `quoteUri`/`blurhash`) are never inspected here, which is
 * itself the tolerant-parsing behavior the permissible_variation fixtures are proving — they
 * survive untouched rather than being stripped or causing rejection.
 */
export function runActivityStreamsStructureCheck(payload: unknown): BoundaryRunResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { outcome: "rejected_parse", reason: "payload is not a JSON object" };
  }
  const activity = payload as JsonRecord;
  const type = activity["type"];

  if (!isNonEmptyString(type)) {
    return { outcome: "rejected_parse", reason: "missing or invalid type" };
  }
  if (!hasValidActor(activity)) {
    return { outcome: "rejected_parse", reason: "missing or invalid actor" };
  }

  if (type === "Follow" || type === "Accept" || type === "Reject") {
    if (!hasValidObjectReference(activity)) {
      return { outcome: "rejected_parse", reason: `${type} requires object` };
    }
  }

  if (type === "Create" || type === "Update") {
    const embedded = activity["object"];
    if (typeof embedded !== "object" || embedded === null || Array.isArray(embedded)) {
      return { outcome: "rejected_parse", reason: `${type} requires an embedded object` };
    }
    const embeddedObject = embedded as JsonRecord;
    const embeddedType = embeddedObject["type"];
    if (!isNonEmptyString(embeddedType)) {
      return { outcome: "rejected_parse", reason: "embedded object missing type" };
    }
    if (
      (embeddedType === "Note" || embeddedType === "Article") &&
      !isNonEmptyString(embeddedObject["attributedTo"])
    ) {
      return { outcome: "rejected_parse", reason: "embedded object missing attributedTo" };
    }
    const attachment = embeddedObject["attachment"];
    if (Array.isArray(attachment)) {
      for (const entry of attachment) {
        if (typeof entry !== "object" || entry === null) {
          return { outcome: "rejected_parse", reason: "attachment entry is not an object" };
        }
        const attachmentRecord = entry as JsonRecord;
        if (attachmentRecord["type"] === "Document" && !isNonEmptyString(attachmentRecord["url"])) {
          return { outcome: "rejected_parse", reason: "Document attachment missing retrievable url" };
        }
      }
    }
  }

  return { outcome: "tolerant_accept" };
}

/**
 * Exercises the `authority_policy` boundary for `Accept` activities carrying an embedded
 * `Follow`: only the actor who was the *target* (`object`) of a Follow may Accept or Reject
 * it. This is the check that makes `mastodon.forged-accept-mismatched-follow` mean something —
 * the fixture is structurally valid (passes `runActivityStreamsStructureCheck` cleanly), so
 * only an authority-aware check can reject it.
 */
export function runAuthorityPolicyCheck(payload: unknown): BoundaryRunResult {
  const structural = runActivityStreamsStructureCheck(payload);
  if (structural.outcome !== "tolerant_accept") return structural;

  const activity = payload as JsonRecord;
  if (activity["type"] !== "Accept") return { outcome: "tolerant_accept" };

  const object = activity["object"];
  if (typeof object !== "object" || object === null) {
    // A bare-IRI Accept.object cannot be authority-checked without dereferencing it, which is
    // out of scope for a hermetic runner. Real dereferencing is exercised by PR #106's live
    // matrix, not here.
    return { outcome: "tolerant_accept" };
  }

  const embeddedFollow = object as JsonRecord;
  if (embeddedFollow["type"] !== "Follow") return { outcome: "tolerant_accept" };

  if (activity["actor"] !== embeddedFollow["object"]) {
    return {
      outcome: "rejected_authority",
      reason: "Accept actor was not the target (object) of the embedded Follow",
    };
  }
  return { outcome: "tolerant_accept" };
}

/**
 * Exercises the `target_persistence` boundary for duplicate delivery: dedupes by activity
 * `id` against a caller-provided ledger. The first delivery of a given id is applied; every
 * subsequent delivery of the same id is a no-op. Callers should deliver a replay fixture twice
 * against the same ledger and assert the *second* result.
 */
export function runReplayIdempotencyCheck(payload: unknown, ledger: Set<string>): BoundaryRunResult {
  const structural = runActivityStreamsStructureCheck(payload);
  if (structural.outcome !== "tolerant_accept") return structural;

  const activity = payload as JsonRecord;
  const id = activity["id"];
  if (!isNonEmptyString(id)) {
    return { outcome: "rejected_parse", reason: "missing activity id, cannot deduplicate" };
  }
  if (ledger.has(id)) {
    return { outcome: "idempotent_replay_noop" };
  }
  ledger.add(id);
  return { outcome: "tolerant_accept" };
}
