# ActivityPub Interoperability Fixture Siblings

Status: **deliverable 5 of `ACTIVITYPUB-INTEROPERABILITY-HARDENING.md`'s ordered deliverables — seed corpus + structural enforcement complete**
Depends on: `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SCHEMA.md` (deliverable 3), `fedify-sidecar/src/interop/ap/FixtureMetadata.ts`

## Scope

Deliverable 5 is "Add malformed/adversarial sibling cases for every permissive fixture
family." That requires two things this change provides:

1. A seed set of fixtures that actually contains matched permissive/adversarial pairs — the
   deterministic "empirical dialect fixtures" CI lane (hardening doc CI lane 3), which is
   distinct from PR #106's live-container matrix (CI lane 4, "cross-implementation live
   smoke" — optional/scheduled, never the only proof). PR #106 does not add any
   `fixtures/**/*.json` ActivityPub payloads; this is the first seed of that lane.
2. A structural check that makes "for every permissive fixture family" an enforced invariant
   rather than a one-time audit: `assertFixtureSiblingCoverage()` in
   `fedify-sidecar/src/interop/ap/FixtureCorpus.ts` runs at module load and throws if any
   fixture family (`targetId` + `capability`) has a `permissible_variation` case without a
   `malformed_structure` / `unsafe_authority_bypass_attempt` / `adversarial_replay` /
   `adversarial_duplicate` sibling in the same family. A future PR that adds a new permissive
   fixture without its sibling fails the build, not a review checklist.

## Seed corpus

All eight fixtures are `sourceClass: "synthetic"` — hand-authored to represent documented,
known dialect behavior (Fedibird/Mastodon `quoteUri`, the widely-deployed `toot:blurhash`
attachment extension, JSON-LD `actor` array-vs-bare-IRI compaction) and known failure modes,
not captured from live traffic in this change. `FixtureMetadataSchema` forbids synthetic
fixtures from carrying live-capture provenance fields, so this is an enforced claim, not an
unchecked one.

| Family (target · capability) | Permissible | Sibling |
|---|---|---|
| mastodon · note | `note-quote-extension-permissible` — tolerant parsing of an unrecognized-but-safe extension term | `note-missing-actor-malformed` — Create with no top-level actor must be rejected at the parser layer |
| mastodon · follow | `follow-actor-array-form-permissible` — `actor` as a single-element array is a JSON-LD compaction detail, not a different claim | `follow-missing-object-malformed` — Follow naming nothing to follow must be rejected |
| gotosocial · note | `note-blurhash-attachment-permissible` — `toot:blurhash` attachment extension tolerated/preserved | `create-duplicate-delivery-replay` — same activity id delivered twice must be idempotent, not a duplicate Note |
| mastodon · accept | — | `forged-accept-mismatched-follow` — an Accept whose embedded Follow the accepting actor was never party to; structurally valid, must be rejected at the `authority_policy` boundary |
| akkoma · media | — | `note-attachment-missing-url-malformed` — a Document attachment with no `url` is unretrievable and must be rejected/dropped |

The last two families are adversarial/malformed-only with no permissive counterpart yet — that
is allowed. The pairing requirement is one-directional (a permissive case obligates a sibling;
an adversarial-only family does not obligate a permissive one) because the point is "don't ship
a tolerance claim without also proving the corresponding rejection boundary," not "every
capability needs both."

## Why `mastodon.forged-accept-mismatched-follow` matters as a distinct case

Most malformed siblings in this seed are missing-required-field cases, caught by structural
parsing alone. The forged-Accept case is deliberately different: the payload is **structurally
valid** ActivityPub — a real-shaped `Accept` wrapping a real-shaped embedded `Follow`. The only
thing wrong with it is that `carol` (the `Accept`'s actor) was never a party to that `Follow`.
This is exactly the class of case `FixtureMetadataSchema` singles out —
`unsafe_authority_bypass_attempt` fixtures are required to exercise an authority-bearing
boundary (`authority_policy`, `visibility_privacy`, or `wire_authentication`), because a check
that only validates embedded-object shape would pass this fixture and prove nothing about
authority enforcement. It is the concrete instance of the hardening doc's "no fixture bypasses
signature, authority, ACL, visibility or addressing checks merely to make parsing pass."

## Adding a new sibling pair

1. Author the permissive payload under `fedify-sidecar/interop/ap/fixtures/<targetId>/`.
2. Author at least one malformed or adversarial payload in the **same** `targetId` +
   `capability` family.
3. Add both to `AP_INTEROP_FIXTURES` in `FixtureCorpus.ts`, following
   `ACTIVITYPUB-INTEROPERABILITY-FIXTURE-SCHEMA.md`'s disposition ↔ expectedOutcome rules.
4. `assertFixtureSiblingCoverage()` (and `FixtureCorpus.test.ts`) will fail if the sibling is
   missing, malformed against the schema, or the JSON payload file doesn't exist on disk.

## Non-goals

This is a seed, not the full capability matrix (deliverable 9) or the Fuzzer/Test-Suite
evaluation (deliverables 7-8). It does not exercise real remote implementations — that remains
PR #106's live-container matrix. It does not change the ADSP transporter decision or the
ActivityPods/SemApps authority and privacy boundaries.
