# ActivityPub Interoperability Fixture Metadata + Redaction Rules

Status: **deliverable 3 of `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`'s ordered deliverables — complete**
Depends on: `docs/phases/ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`, `fedify-sidecar/src/interop/ap/InteropTargetRegistry.ts`, `fedify-sidecar/src/interop/ap/SemanticInteropAssertion.ts`

## Purpose

`ACTIVITYPUB-INTEROPERABILITY-HARDENING.md` requires that every discovered implementation
dialect become a "local, redacted, hermetic regression fixture" before it counts as covered,
and separately lists non-negotiable privacy invariants (no private/followers-only/direct data
harvested into public fixture corpora; synthetic identifiers unless identity is materially
necessary; parser tolerance must never become trust tolerance). Deliverable 4 (seeding the
cross-implementation fixture corpus, currently in flight via the multi-implementation
federation matrix) needs a schema those fixtures can be checked against — otherwise "redacted"
and "hermetic" stay prose intentions instead of something CI can fail closed on.

This document describes that schema. The executable contract lives in
`fedify-sidecar/src/interop/ap/FixtureMetadata.ts`; this file is the human-readable map of it.

## What a fixture metadata record is

Every ActivityPub interoperability fixture used as CI-executable evidence under
`fedify-sidecar/interop/ap/fixtures/<targetId>/` must have a companion metadata object that
validates against `FixtureMetadataSchema` (`ap-interop-fixture-v1`). The schema governs the
*record describing the fixture* — provenance, redaction status, expected result — not the raw
ActivityPub JSON payload itself.

A fixture without a valid metadata record is not trusted evidence. It is the same posture
`SemanticInteropAssertion.ts` takes for interop test *results*: schema-shaped evidence only.

## Fields

| Field | Purpose |
|---|---|
| `fixtureId` | Stable id, `^[a-z0-9][a-z0-9._-]*$`. |
| `targetId` | Must resolve to a real entry in `InteropTargetRegistry.ts` — no fixture for an ungoverned target. |
| `capability` | Must be one of the target's declared `capabilities`. |
| `softwareVersion` | The exact version/release/commit family observed, per the target's `versionPolicy`. |
| `sourceClass` | `live_capture` \| `hybrid_reduced` \| `synthetic` — where the shape actually came from. |
| `disposition` | `permissible_variation` \| `malformed_structure` \| `unsafe_authority_bypass_attempt` \| `adversarial_replay` \| `adversarial_duplicate`. |
| `expectedOutcome` | `tolerant_accept` \| `ignored_extension` \| `rejected_parse` \| `rejected_authority` \| `rejected_visibility` \| `idempotent_replay_noop`. |
| `boundariesExercised` | Reuses `SemanticInteropAssertion.ts`'s `AssertionBoundarySchema` — which processing boundary this fixture is meant to exercise. |
| `relativeFixturePath` | Enforces the `<targetId>/<fixtureId>.(json\|jsonld)` directory convention; the path's first segment must equal `targetId`. |
| `redaction` | See below. |
| `regressionClassification` | BrowserPub-to-regression workflow step 7 classification; required for anything not purely synthetic. |

## Disposition ↔ expected-outcome agreement (encoded, not just documented)

The hardening doc's "Required harness properties" say: malformed/unsafe variants must prove
rejection at the correct boundary; permissible variation must prove tolerant parsing;
duplicate/replay/order tests must stay idempotent. `FixtureMetadataSchema` enforces this as a
parse-time invariant rather than a review checklist item:

- `malformed_structure` / `unsafe_authority_bypass_attempt` → `expectedOutcome` **must** be one
  of the `rejected_*` values. A fixture cannot claim to be an unsafe input and also expect
  `tolerant_accept` — that combination fails to parse.
- `permissible_variation` → `expectedOutcome` **must** be `tolerant_accept` or
  `ignored_extension`.
- `adversarial_replay` / `adversarial_duplicate` → `expectedOutcome` **must** be
  `idempotent_replay_noop`.
- `unsafe_authority_bypass_attempt` additionally **must** include an authority-bearing boundary
  (`authority_policy`, `visibility_privacy`, or `wire_authentication`) in
  `boundariesExercised`. A bypass attempt that only exercises `activitystreams_structure`
  proves nothing about authority enforcement and is rejected by the schema — this is the
  concrete form of "no fixture bypasses signature, authority, ACL, visibility or addressing
  checks merely to make parsing pass."

## Redaction rules

The `redaction` object is where "private/followers-only/direct data must not be harvested"
and "remote object IDs and actor IDs should be synthetic unless identity is materially
necessary" become enforceable:

- **`containsRealUserContent` is `z.literal(false)`.** There is no schema-valid way to author
  a fixture that admits real user content. A captured fixture that has not been scrubbed yet
  is not eligible to become a fixture — this is checked before the metadata object can even
  parse, not after.
- **`identifierScheme`** defaults to the expectation of `synthetic_example_domain` (actor/object
  IRIs rewritten to harness-owned `*.example` identifiers). Choosing
  `real_identity_justified` requires a non-empty `identityJustificationNote` explaining why —
  e.g. a fixture that must pin the exact well-known relay actor IRI. Unjustified real identity
  fails to parse.
- **`visibilityClassRepresented`** reuses `SemanticInteropAssertion.ts`'s `VisibilityClassSchema`
  so a fixture can structurally represent `followers`/`direct` visibility (that's a legitimate,
  necessary test case) while `containsRealUserContent: false` guarantees the *content* behind
  that visibility class is synthetic, not a real private post.
- **`capturedResponseHeadersRedacted`** records that raw captured headers were pruned to only
  schema-relevant fields (content-type/media-type) before the fixture was committed.
- **`sourceCaptureDate` + `sourceCaptureNote`** are required for `live_capture`/`hybrid_reduced`
  fixtures (implementation/version/media-type provenance, per workflow step 4) and are
  explicitly forbidden on `synthetic` fixtures — a synthetic fixture that carries live-capture
  provenance fields is a contradiction and fails to parse.

## Fixture lifecycle (BrowserPub-to-regression workflow, restated against this schema)

1. Identify the remote actor/object/activity that behaves differently.
2. Inspect its ActivityPub representation (BrowserPub or direct protocol inspection).
3. Remove private/user-identifying content; set `identifierScheme: synthetic_example_domain`
   unless real identity is materially necessary.
4. Record implementation/version and relevant response headers/media type into
   `softwareVersion` / `redaction.sourceCaptureNote`.
5. Reduce to the minimal failing fixture; store it at
   `fedify-sidecar/interop/ap/fixtures/<targetId>/<fixtureId>.json`.
6. Reproduce against ActivityPods/SemApps normalization.
7. Classify the failure into `regressionClassification`.
8. Author the `FixtureMetadataSchema` record — `disposition` and `expectedOutcome` must agree
   (enforced by the schema, see above).
9. Add the permanent regression test at the lowest correct layer.
10. Prove existing fixtures did not regress.

## Non-goals

This schema does not select which fixtures to add (that is deliverable 4, the fixture corpus
itself) and does not change ADSP's transporter decision or the ActivityPods/SemApps authority
and privacy boundaries. It is a validity gate for fixtures, not a coverage plan.
