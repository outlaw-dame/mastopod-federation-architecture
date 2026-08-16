# APDM Status

Last updated: 2026-08-16

This file is the live cross-repository evidence ledger. `PHASES.md` defines the roadmap and exit gates.

## Gate semantics

- **PASS / `[x]`** means the phase exit gate is closed, not merely that an implementation PR exists.
- **IN PROGRESS / `[ ]`** means work may be implemented but one or more required correctness/evidence/promotion gates remain open.
- **BLOCKED / NOT STARTED** means dependent work must not be treated as phase completion.
- Supporting FEP/ATProto/identity/queue/media/security/scalability PRs do not advance APDM phase state unless explicitly required by a phase gate.

## Program checklist

- [x] APDM-P0 — baseline and authority
- [x] APDM-P1 — Delivery Plan v1
- [x] APDM-P2 — pre-`remotePost` strategy seam
- [x] APDM-P3 — authoritative expanded recipient planning
- [x] APDM-P4 — durable sidecar handoff
- [x] APDM-P5 — Fedify remote-authority cutover
- [x] APDM-P6 — duplicate remote routing retired
- [x] APDM-P7 — duplicate local account lookup removed
- [x] APDM-P8 — real nested Tier 1 measurements complete
- [x] APDM-P9 — bounded concurrency measured and c4 promoted
- [ ] APDM-P10 — metadata round-trip reduction — **IN PROGRESS**
- [ ] APDM-P11–P16 — blocked/not started behind preceding gates

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged; hardening PR #23 merged | PR #9 merged; hardening PR #18 merged | PASS |
| APDM-P2 | PR #15 merged; hardening PR #22 merged | PR #10 merged; hardening PR #16 merged; closeout #17 | PASS |
| APDM-P3 | PR #16 merged; hardening PR #21 merged | PR #11 merged; hardening PR #14 merged; closeout #15 | PASS |
| APDM-P4 | PR #17 merged; replay-horizon producer hardening later merged | PR #12 merged; closeout #13; replay hardening #25 | PASS |
| APDM-P5 | PR #26 merged (`427d3d3258382f91355ff08c33cfd40360087d84`) | PR #28 merged (`a6f6af242c11e098cfc6692c42988016d7b5a2a3`) | PASS |
| APDM-P6 | PR #27 merged (`8f6a1bd244015c58698d92a9b9fd939a602d6b96`) | PR #30 merged (`0e350e0baa51d94d874ee99a18ee3140fc85d3a3`) | PASS |
| APDM-P7 | PR #28 merged (`6d65b2375b9860229dda3d081446f890bfa8699e`) | not required | PASS |
| APDM-P8 | PRs #29/#30; #30 merged (`e51e5cacd0696e558d7860920025279c9cad22ed`) | as needed | PASS |
| APDM-P9 | PR #65 primitive (`8684c58ad1d494e60ffcfa15ab19ef1c67cce16c`); PR #66 evidence (`154b40873fec0886c4e2a25e67d6e644fe69ec4c`); PR #68 c4 promotion (`5d7f2ff0631402e143000af68c174f8c615a755a`) | not required | PASS |
| APDM-P10 | PR #67 implementation/hardening open; real OFF/ON c4 run `31965449687` launched from `1f512cfb192ab469b9684cb17a7e3af2756a3cdb`; result/promotion decision pending | as needed | IN PROGRESS |
| APDM-P11 | not started | as needed | BLOCKED by P10 |
| APDM-P12 | not started | as needed | BLOCKED by preceding phases |
| APDM-P13 | not started | as needed | BLOCKED by preceding phases |
| APDM-P14 | not started | primary federation slice later | BLOCKED by preceding phases |
| APDM-P15 | not started | not started | BLOCKED by preceding phases |
| APDM-P16 | not started | not started | BLOCKED by preceding phases |

## Phases 0–4 closure summary

These earlier phases are fully closed even though their detailed evidence is spread across phase-specific docs and PR history:

- **P0:** both repositories recorded the SemApps 1.1.4 baseline, ownership split and shared phase program before runtime migration work began.
- **P1:** ActivityPods producer and federation consumer agreed on `ap.delivery-plan.v1`; fixtures/schema semantics were hardened in both repos.
- **P2:** ActivityPods introduced the fail-closed pre-`remotePost` native/external strategy seam while keeping native rollback; paired federation documentation/hardening recorded the seam assumptions.
- **P3:** recipient expansion/planning became ActivityPods-authoritative and the sidecar consumed concrete resolved targets instead of independently treating raw addressing as authority.
- **P4:** ActivityPods → sidecar handoff became durable/idempotent; crash/retry/replay behavior was hardened, including the bounded replay/completion-marker horizon.

No later optimization changes those authority decisions.

## Phase 5 closure

Phase 5 established the remote-authority cutover with deterministic rollback:

- `native` mode keeps SemApps native remote delivery;
- `external` mode creates zero SemApps native `remotePost` jobs and uses the durable `ap.delivery-plan.v1` handoff;
- the federation sidecar/Fedify path is the sole external ActivityPub HTTP executor in external mode;
- ActivityPods retains key custody and signing authority;
- the sidecar outbound boundary is DNS-aware, pins vetted resolution, disables redirects, and rejects unsafe destinations;
- exact-head CI and review gates were clean in both repositories before merge.

## Phase 6 closure

Phase 6 retired transitional duplicate recipient routing while preserving indexing and rollback semantics:

- ActivityPods no longer reconstructs remote recipients from raw Activity `to`/`cc`/`bto`/`bcc`, Follow targets, actor lookups, or shared-inbox inference in `outbox-emitter`;
- external delivery authority is bound end-to-end to one Delivery Plan intent ID across target markers, `X-APDM-Intent-Id`, metadata, and the durable sidecar intent;
- native rollback preserves Stream1/search observation through the targetless `/webhook/outbox-observation` path, which cannot create outbound federation jobs;
- external Delivery Plan handoffs and native observations use isolated durable intent namespaces;
- stale copied raw-routing integration code and operator instructions were removed.

## Phase 7 closure

Phase 7 removed the proven duplicate local account lookup without changing local storage semantics:

- the pinned `@semapps/activitypub@1.1.4` outbox still validates each local recipient once with `auth.account.findByWebId`;
- the already-resolved account-derived dataset is carried into `localPost()` through a request-local, non-enumerable Symbol-bound context;
- `localPost()` consumes/removes that private context before its first await;
- direct legacy `localPost()` callers retain the original account lookup fallback;
- inbox lookup/add, `ldp.remote.store`, activity attachment, emitted semantics, and dataset/ACL boundaries remain unchanged;
- the install-time compatibility patch is pinned to SemApps 1.1.4 and fails closed on source/version drift.

## Phase 8 closure

Phase 8 completed the real local Tier 1 measurement/integrity work before concurrency changes:

- real Pod-backed actors are provisioned through normal ActivityPods signup/bootstrap;
- benchmark roots invoke the normal `activitypub.outbox.post` path;
- detached `localPost()` completion and caught per-recipient failures are correlated so partial/lower fan-out cannot count as a successful sample;
- warm-restart readiness verifies required services/migration state before each measurement;
- canonical N=1/10/100/200/1000 measurements captured nested Moleculer work, Fuseki requests, CPU, heap and elapsed time.

Representative Phase 8 means:

| N | elapsed | nested actions | Fuseki requests | CPU |
|---:|---:|---:|---:|---:|
| 1 | 1.354 s | 938 | 318 | 1.559 s |
| 10 | 2.900 s | 1,465.7 | 586.3 | 2.974 s |
| 100 | 25.171 s | 6,611.7 | 3,202.3 | 25.084 s |
| 200 | 50.537 s | 12,286.3 | 6,093.7 | 49.970 s |
| 1000 | 333.538 s | 57,911.3 | 29,303 | 315.461 s |

The measured fits were roughly `57.02` nested actions and `29.01` Fuseki HTTP requests per additional recipient. This retired the old source-counted estimate as a total-work model and established the evidence baseline for P9/P10.

## Phase 9 closure

Phase 9 introduced bounded scheduling, measured it on the real local-delivery path, then promoted only the smallest empirically qualified concurrency:

- PR #65 adds a fixed-size worker pool to the pinned SemApps `localPost()` path; `Promise.all()` is used only over workers, never one promise per recipient;
- recipient-specific Pod dataset, inbox, LDP, WebACL and activity-attachment semantics remain on the existing path;
- results are reconstructed in original recipient order so concurrent physical completion does not alter the `{ success, failures }` contract;
- canonical run `31956939507` measured c1/c2/c4/c8 with three successful samples at every canonical N and zero failed samples;
- its original compare job failed after measurement because of artifact handling; immutable raw evidence was preserved;
- PR #66 repaired replay/comparison and hardened selection; replay `31964215322` independently selected c4;
- c4 delivered about `1.19x`, `1.21x`, `1.34x` wall-clock speedups at N=100/200/1000 with CPU deltas around `-15.8%`, `-16.8%`, `-25.1%`;
- action/Fuseki counts remained near-invariant, supporting a scheduling improvement rather than skipped persistence work;
- PR #68 promotes the normal unset default to `4`; explicit `1` is serial rollback; malformed explicit configuration fails safe to `1`; hard maximum remains `32`;
- already-c1-patched installations have an exact c1→c4 migration marker/path and drifted legacy artifacts fail closed;
- exact-head Backend Checks `31964533972` passed before promotion merge.

Phase 9 deliberately does not claim to remove the underlying O(N) metadata/persistence amplification.

## Phase 10 current state

Phase 10 was refined after Phase 8 evidence rather than forcing the original generic batching hypothesis. At N=1000, repeated dataset-existence authority checks were a major safe-looking metadata amplifier, while actor/inbox resource reads already benefited substantially from caching.

ActivityPods PR #67 therefore begins P10 with a fail-closed, delivery-scoped **positive dataset-existence reuse** mechanism:

- scope is exactly one patched SemApps `localPost()` async lineage, not the whole outbox action;
- only strict `true` `triplestore.dataset.exist` results are reused;
- false/error results are never cached;
- dataset lifecycle operations invalidate before/after mutation;
- a mutation epoch prevents an older in-flight positive probe from repopulating stale state;
- the SemApps `@semapps/triplestore@1.1.4` existence contract is compatibility-pinned;
- correlated real Fuseki method+path evidence distinguishes `GET /$/datasets/{dataset}` from lifecycle writes;
- configuration and middleware default remain **disabled/fail-closed** until evidence supports a promotion.

P10 launch gates already closed:

- [x] PR #67 rebased on the merged c4 Phase 9 baseline;
- [x] implementation underwent adversarial/Codex-level self-review and race/scope/provenance hardening;
- [x] exact-head Backend Checks `31965391790` passed on frozen head `1f512cfb192ab469b9684cb17a7e3af2756a3cdb`;
- [x] dedicated measurement branch points to that exact source, avoiding source drift during the experiment;
- [x] real OFF/ON run `31965449687` launched with c4 in both arms and memo disabled during fixture provisioning.

P10 remains open until all of these are closed:

- [ ] both arms complete the canonical N=1/10/100/200/1000 matrix with >=3 matched successful samples and zero failed samples;
- [ ] hard provenance proves same run/commit/c4/runtime/dependency-image environment and opposite memo flags;
- [ ] N=100/200/1000 each reduce real dataset-registry GETs by >=50%;
- [ ] total Fuseki HTTP work falls in every large case;
- [ ] delivery outcomes, LDP/WebACL/Pod boundaries and partial-failure behavior remain correct;
- [ ] CPU/heap/latency and hardware resource-comparability evidence are reviewed;
- [ ] a separate evidence-backed decision either promotes the normal default or explicitly leaves it disabled;
- [ ] only then is Phase 10 marked PASS and Phase 11 unblocked.

## Supporting/adjacent hardening

Merged work such as ActivityPods reconciliation/selectivity/scalability PRs #33–#64 and federation FEP/queue/identity/ATProto/media/security performance work strengthens the system and may affect later measurements, but those PRs are not retroactively relabeled as APDM phase completion. Their role is **supporting hardening** unless a specific phase exit gate cites them.

## Next gate

Finish and review Phase 10 run `31965449687`; do not infer success from setup progress or unit CI. Update this ledger with the actual OFF/ON results and promotion decision. Phase 11 remains blocked until P10 is genuinely PASS.
