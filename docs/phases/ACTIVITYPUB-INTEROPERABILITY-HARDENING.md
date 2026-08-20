# ActivityPub Interoperability Hardening Phase

Status: **planned bounded follow-on; do not interrupt the active ADSP P2 / ActivityPods PR #106 node-loss proof**.

This phase exists to turn real-world Fediverse implementation variance into reusable ActivityPods/SemApps compatibility evidence for both the platform itself and applications built on ActivityPods.

## Why this phase exists

ActivityPub interoperability is not adequately represented by a binary `ActivityPub-compatible` flag. Real deployed implementations vary in ActivityStreams object shape, optional properties, extensions, collection behavior, actor/account migration, media, replies, quotes, polls, groups, moderation behavior, addressing, and other implementation conventions.

The desired testing model combines four complementary layers:

1. **Live protocol inspection** — inspect what a real remote endpoint actually emits.
2. **Empirical schema corpus** — learn which shapes are observed across software and versions.
3. **Executable compatibility fixtures/fuzzing** — replay those shapes locally and deterministically.
4. **Normative/feature conformance** — verify ActivityPub/ActivityStreams requirements and selected Fediverse Extension Proposal / feature behavior.

This phase must remain subordinate to ActivityPods/SemApps authority and privacy rules. It must not create a second federation path or normalize unsafe input into trusted state.

## External projects to use or emulate

### BrowserPub

Use BrowserPub as a **human-driven investigation and reproduction aid**, not as a required CI dependency.

Primary use:

- inspect actors, objects, activities, collections, and authenticated endpoints;
- compare remote wire representation with ActivityPods/SemApps normalized representation;
- reproduce interoperability reports from app developers;
- capture the minimal protocol facts needed to construct a regression fixture.

Any useful discovery must be converted into a local, redacted, hermetic regression fixture before it is considered covered.

### Fediverse Schema Observatory

Use Observatory data as empirical evidence of implementation/version variance.

Primary use:

- identify common and unusual activity/object schemas;
- track implementation/version-specific field combinations;
- prioritize fixture coverage based on observed deployment behavior rather than guesses;
- identify extension terms that should be preserved as opaque/unrecognized data rather than causing unrelated valid input to collapse.

Observatory data is evidence, not an authority override. ActivityPods privacy, signature, addressing, authorization, and semantic validation remain fail-closed where required.

### ActivityPub Fuzzer

Evaluate direct reuse where practical; otherwise emulate its core method by turning observed implementation dialects into executable inbound/outbound regression cases.

Required properties of our harness:

- deterministic and hermetic;
- fixture provenance records source software/version/schema family without retaining private user data;
- malformed/unsafe variants prove rejection at the correct boundary;
- permissible variation proves tolerant parsing/normalization;
- unknown extension properties are preserved where safe and semantically possible;
- duplicate/replay/order tests remain idempotent;
- no fixture may bypass signature, authority, ACL, visibility, or addressing checks merely to make parsing pass.

### ActivityPub Test Suite / FEP-oriented tests

Track and integrate useful server-conformance tests as the ecosystem matures.

Use normative tests for protocol baseline behavior, then keep implementation-dialect fixtures as a separate empirical layer so we can distinguish:

- spec failure;
- feature/FEP incompatibility;
- real-world implementation variance;
- ActivityPods application rendering/normalization bugs.

## ActivityPods-specific test architecture

Introduce a compatibility harness with a stable normalized test contract rather than application-specific assertions.

Suggested logical pipeline:

```text
fixture/live capture
      |
      v
transport + signature/authority validation
      |
      v
ActivityPub / ActivityStreams parser
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

The harness should make it possible for an ActivityPods application author to answer:

> "Does my application correctly consume the ActivityPods-normalized form of the Fediverse variants the platform supports?"

without requiring each application to reimplement HTTP signatures, ActivityPub authority, ontology expansion, or remote fetch security.

## Fixture taxonomy

At minimum maintain fixtures by **software family + version family + feature**, including representative current versions of:

- Mastodon;
- Akkoma/Pleroma-compatible software;
- GoToSocial;
- Misskey and relevant derivatives;
- Pixelfed;
- PeerTube;
- Lemmy / PieFed / other link-aggregation implementations where relevant;
- WordPress ActivityPub;
- Ghost;
- WriteFreely;
- Bonfire;
- Mobilizon / Group-oriented implementations where relevant.

Do not turn this into a compatibility promise for every feature of every implementation. Coverage must be capability-specific and evidence-backed.

## Capability profile

Replace any simplistic compatibility notion in testing/docs with a capability matrix. Candidate dimensions:

### Core objects / activities

- actor discovery and dereferencing;
- `Note`;
- `Article`;
- `Create` / `Update` / `Delete`;
- replies and conversation linkage;
- `Like`;
- `Announce` / boosts;
- follows, accepts, rejects, undo;
- media attachments;
- collections and pagination.

### Common Fediverse behavior

- polls/questions;
- quote-post representation(s);
- hashtags / mentions;
- sensitive/content-warning metadata;
- custom emoji;
- actor aliases and `Move` / migration;
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

A capability marked supported must have an executable test or a deliberately documented reason why only manual validation is currently possible.

## BrowserPub-to-regression workflow for developers

Document a reproducible issue workflow for ActivityPods application developers:

1. identify the remote actor/object/activity that behaves differently;
2. inspect its ActivityPub representation with BrowserPub or equivalent direct protocol inspection;
3. remove private/user-identifying content while retaining schema-relevant structure;
4. record implementation/version and relevant response headers/media type;
5. reduce to the minimal failing fixture;
6. reproduce against ActivityPods/SemApps normalization;
7. classify the failure as transport/authority, parsing, ontology/semantic normalization, authorization/visibility, or app presentation;
8. add a permanent regression test at the lowest correct layer;
9. only then modify behavior;
10. prove existing implementations/fixtures did not regress.

This workflow should make interoperability bugs diagnosable without teaching every application developer the entire SemApps federation implementation.

## Security and privacy invariants

The interoperability harness must never convert parser tolerance into trust tolerance.

Non-negotiable:

- SSRF and remote-fetch protections remain enforced;
- HTTP signature / actor authority boundaries are not bypassed in integration tests unless a unit test explicitly targets a lower parser layer;
- private/followers-only/direct data must not be harvested into public fixture corpora;
- fixtures derived from real traffic must be redacted/minimized;
- remote object IDs and actor IDs should be synthetic unless identity is materially necessary to the interoperability behavior;
- unknown extensions may be preserved as opaque data but must not silently grant capabilities, authority, visibility, or executable semantics;
- unsupported semantic ambiguity fails at the correct boundary rather than being guessed.

## CI lanes

Use separate lanes so failures remain interpretable:

1. **ActivityStreams semantic baseline** — local ontology/context expansion for required vocabulary (already strengthened during PR #106).
2. **Normative ActivityPub conformance** — selected stable test-suite cases.
3. **Empirical dialect fixtures** — deterministic Observatory/Fuzzer-inspired cases.
4. **Cross-implementation live smoke** — optional/scheduled, never the only proof because remote services are nondeterministic.
5. **Application compatibility contract** — verifies the stable normalized representation exposed to ActivityPods app code.

Live third-party availability must not gate ordinary pull requests. A scheduled/live lane may detect ecosystem drift and open/update compatibility issues, but hermetic fixtures are the merge gate.

## Initial deliverables

1. Inventory current ActivityPods/SemApps ActivityPub parser/normalizer tests and identify which layers already exist.
2. Define the stable normalized interoperability assertion model exposed to ActivityPods application tests.
3. Add fixture metadata/schema and redaction rules.
4. Seed fixtures with a small representative cross-implementation set rather than a huge unreviewed corpus.
5. Add malformed/adversarial sibling cases for every permissive fixture family.
6. Add BrowserPub/manual-inspection debugging guide for app developers.
7. Evaluate the ActivityPub Fuzzer for direct reusable fixtures/harness code; otherwise implement an adapter/importer rather than copying behavior ad hoc.
8. Evaluate current ActivityPub Test Suite cases and adopt stable, relevant cases without coupling ActivityPods to an unstable external service.
9. Produce a capability matrix generated from executable evidence where feasible.
10. Add scheduled ecosystem-drift review of Observatory/test-suite changes only after the hermetic baseline is stable.

## Acceptance criteria

This phase is complete only when:

- representative real-world implementation variants are executable in local CI;
- tolerant inputs and unsafe inputs are clearly separated by test expectations;
- tests exercise the ActivityPods/SemApps authority and privacy boundaries rather than bypassing them;
- an app developer can add a regression fixture without modifying core federation plumbing;
- capability documentation maps to actual tests;
- live inspection tools are aids, not hard runtime/CI dependencies;
- no second federation authority path is introduced;
- the existing ADSP evidence gates remain unchanged.

## Scheduling relative to current ADSP work

Do **not** start implementation while ActivityPods PR #106 is still the primary active workstream.

After PR #106 is resolved and the corresponding federation architecture status is reconciled, evaluate this phase against the next already-planned primary ADSP item. If another prerequisite phase must precede it, retain this document as a queued interoperability-hardening phase rather than silently reprioritizing the roadmap.
