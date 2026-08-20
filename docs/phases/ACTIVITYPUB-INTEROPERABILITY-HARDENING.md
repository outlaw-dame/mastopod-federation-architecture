# ActivityPub Interoperability Hardening Phase

Status: **ACTIVE — authorized after ADSP Phase-2 closeout on 2026-08-20**.

ADSP Phase 2 is complete as an evidence phase but the Redis horizontal topology is non-promotable because canonical N=100 failed the frozen scale gates. Phase 3 NATS therefore remains closed. This interoperability phase is a separate bounded product/protocol-hardening workstream; it does not reopen or bypass the transporter decision.

This phase exists to turn real-world Fediverse implementation variance into reusable ActivityPods/SemApps compatibility evidence for both the platform itself and applications built on ActivityPods.

## Why this phase exists

ActivityPub interoperability is not adequately represented by a binary `ActivityPub-compatible` flag. Real deployed implementations vary in ActivityStreams object shape, optional properties, extensions, collection behavior, actor/account migration, media, replies, quotes, polls, groups, moderation behavior, addressing and implementation conventions.

The testing model combines four complementary layers:

1. **Live protocol inspection** — inspect what a real remote endpoint actually emits.
2. **Empirical schema corpus** — learn which shapes are observed across software/version families.
3. **Executable compatibility fixtures/fuzzing** — replay those shapes locally and deterministically.
4. **Normative/feature conformance** — verify ActivityPub/ActivityStreams requirements and selected FEP/feature behavior.

This work remains subordinate to ActivityPods/SemApps authority and privacy rules. It must not create a second federation path or normalize unsafe input into trusted state.

## External projects to use or emulate

### BrowserPub

Use BrowserPub as a human-driven investigation/reproduction aid, not as a required CI dependency.

Use it to inspect actors, objects, activities, collections and authenticated endpoints; compare remote wire representation with ActivityPods/SemApps normalization; and reduce interoperability reports to the protocol facts needed for a regression fixture.

Any useful discovery must become a local, redacted, hermetic regression fixture before it is considered covered.

### Fediverse Schema Observatory

Use Observatory data as empirical evidence of implementation/version variance to prioritize fixtures and identify extension terms that should be preserved safely rather than causing unrelated valid input to collapse.

Observatory data is evidence, not an authority override. ActivityPods privacy, signature, addressing, authorization and semantic validation remain fail-closed where required.

### ActivityPub Fuzzer

Evaluate direct reuse where practical; otherwise emulate its core method by turning observed implementation dialects into executable inbound/outbound regression cases.

Required harness properties:

- deterministic and hermetic;
- fixture provenance records software/version/schema family without retaining private user data;
- malformed/unsafe variants prove rejection at the correct boundary;
- permissible variation proves tolerant parsing/normalization;
- unknown extension properties are preserved where safe and semantically possible;
- duplicate/replay/order tests remain idempotent;
- no fixture bypasses signature, authority, ACL, visibility or addressing checks merely to make parsing pass.

### ActivityPub Test Suite / FEP-oriented tests

Track and integrate useful server-conformance cases as the ecosystem matures.

Normative tests and implementation-dialect fixtures remain separate so failures can be classified as:

- specification failure;
- FEP/feature incompatibility;
- real-world implementation variance;
- ActivityPods application rendering/normalization bug.

## ActivityPods-specific test architecture

Introduce a stable normalized compatibility contract rather than application-specific assertions:

```text
fixture/live capture
      |
      v
transport + signature/authority validation
      |
      v
ActivityPub / ActivityStreams parsing
      |
      v
SemApps / ActivityPods semantic normalization
      |
      +--> authorization / ACL / visibility decision
      |
      v
stable interoperability assertion model
      |
      +--> optional app-level renderer/feature tests
```

An ActivityPods application author should be able to answer:

> Does my application correctly consume the ActivityPods-normalized form of the Fediverse variants the platform supports?

without reimplementing HTTP signatures, ActivityPub authority, ontology expansion or remote-fetch security.

## Fixture taxonomy

Maintain fixtures by **software family + version family + capability**, beginning with representative current variants of:

- Mastodon;
- Akkoma/Pleroma-compatible software;
- GoToSocial;
- Misskey and relevant derivatives;
- Pixelfed;
- PeerTube;
- Lemmy / PieFed / link-aggregation implementations where relevant;
- WordPress ActivityPub;
- Ghost;
- WriteFreely;
- Bonfire;
- Mobilizon / group-oriented implementations where relevant.

Coverage is capability-specific and evidence-backed; it is not a blanket compatibility promise for every feature of every implementation.

## Capability profile

The executable matrix should cover, where supported:

### Core objects / activities

- actor discovery/dereferencing;
- `Note`;
- `Article`;
- `Create` / `Update` / `Delete`;
- replies/conversation linkage;
- `Like`;
- `Announce`;
- follow/accept/reject/undo;
- media attachments;
- collections/pagination.

### Common Fediverse behavior

- polls/questions;
- quote-post representations;
- hashtags/mentions;
- sensitive/content-warning metadata;
- custom emoji;
- actor aliases and `Move` migration;
- group actors;
- link/article objects;
- audience/addressing differences;
- shared inbox behavior;
- application-specific extension properties.

### Moderation / safety

- blocks;
- reports/flags where supported;
- visibility/addressing enforcement;
- deleted/tombstoned objects;
- actor/domain policy interactions.

A capability marked supported must have executable evidence or a deliberately documented reason why only manual validation is currently possible.

## BrowserPub-to-regression workflow

1. Identify the remote actor/object/activity that behaves differently.
2. Inspect its ActivityPub representation with BrowserPub or equivalent direct protocol inspection.
3. Remove private/user-identifying content while retaining schema-relevant structure.
4. Record implementation/version and relevant response headers/media type.
5. Reduce to the minimal failing fixture.
6. Reproduce against ActivityPods/SemApps normalization.
7. Classify the failure as transport/authority, parsing, ontology/semantic normalization, authorization/visibility or app presentation.
8. Add a permanent regression test at the lowest correct layer.
9. Only then modify behavior.
10. Prove existing implementation fixtures did not regress.

## Security and privacy invariants

Parser tolerance must never become trust tolerance.

Non-negotiable:

- SSRF and remote-fetch protections remain enforced;
- HTTP signature / actor-authority boundaries are not bypassed in integration tests unless a unit test explicitly targets a lower parser layer;
- private/followers-only/direct data must not be harvested into public fixture corpora;
- fixtures derived from real traffic must be redacted/minimized;
- remote object IDs and actor IDs should be synthetic unless identity is materially necessary;
- unknown extensions may be preserved as opaque data but must not silently grant capabilities, authority, visibility or executable semantics;
- unsupported semantic ambiguity fails at the correct boundary rather than being guessed.

## CI lanes

Keep failures interpretable with separate lanes:

1. **ActivityStreams semantic baseline** — local ontology/context expansion; the PR #106 58-type semantic proof is the starting floor.
2. **Normative ActivityPub conformance** — selected stable test-suite cases.
3. **Empirical dialect fixtures** — deterministic Observatory/Fuzzer-inspired cases.
4. **Cross-implementation live smoke** — optional/scheduled; never the only proof.
5. **Application compatibility contract** — stable normalized representation exposed to ActivityPods app code.

Live third-party availability must not gate ordinary pull requests. Scheduled/live checks may detect ecosystem drift, but hermetic fixtures are the merge gate.

## Ordered deliverables

1. **Inventory existing ActivityPods/SemApps parser, normalizer, semantic, authority and app-facing tests.**
2. Define the stable normalized interoperability assertion model exposed to ActivityPods application tests.
3. Add fixture metadata/schema and redaction rules.
4. Seed a small representative cross-implementation fixture set.
5. Add malformed/adversarial sibling cases for every permissive fixture family.
6. Add BrowserPub/manual-inspection debugging guidance for app developers.
7. Evaluate ActivityPub Fuzzer reuse/import rather than copying behavior ad hoc.
8. Evaluate current ActivityPub Test Suite/FEP cases and adopt stable relevant cases without coupling CI to an unstable remote service.
9. Produce a capability matrix generated from executable evidence where feasible.
10. Add scheduled ecosystem-drift review only after the hermetic baseline is stable.

## Acceptance criteria

The phase is complete only when:

- representative real-world implementation variants are executable in local CI;
- tolerant inputs and unsafe inputs are clearly separated by test expectations;
- tests exercise ActivityPods/SemApps authority/privacy boundaries rather than bypassing them;
- an app developer can add a regression fixture without modifying core federation plumbing;
- capability documentation maps to actual tests;
- live inspection tools are aids, not hard runtime/CI dependencies;
- no second federation authority path is introduced;
- ADSP evidence gates remain unchanged.

## Current boundary

Phase implementation may now proceed because ActivityPods PR #106 is merged and ADSP Phase 2 is reconciled in `P2-CLOSEOUT-2026-08-20.md`, `PHASES.md` and `STATUS.md`.

The first active task is the repository/test-layer inventory. Do not jump directly to a large fixture corpus or live third-party matrix before that inventory defines the lowest correct assertion boundaries.
