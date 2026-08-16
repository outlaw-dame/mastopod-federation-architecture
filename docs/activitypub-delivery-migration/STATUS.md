# APDM Status

Last updated: 2026-08-16

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged; hardening PR #23 merged | PR #9 merged; hardening PR #18 merged | PASS |
| APDM-P2 | PR #15 merged; hardening PR #22 merged | PR #10 merged; hardening PR #16 merged | PASS |
| APDM-P3 | PR #16 merged; hardening PR #21 merged | PR #11 merged; hardening PR #14 merged | PASS |
| APDM-P4 | PR #17 merged | PR #12 merged | PASS |
| APDM-P5 | PR #26 merged (`427d3d3258382f91355ff08c33cfd40360087d84`) | PR #28 merged (`a6f6af242c11e098cfc6692c42988016d7b5a2a3`) | PASS |
| APDM-P6 | PR #27 merged (`8f6a1bd244015c58698d92a9b9fd939a602d6b96`) | PR #30 merged (`0e350e0baa51d94d874ee99a18ee3140fc85d3a3`) | PASS |
| APDM-P7 | PR #28 merged (`6d65b2375b9860229dda3d081446f890bfa8699e`) | not required | PASS |
| APDM-P8 | PR #30 merged (`e51e5cacd0696e558d7860920025279c9cad22ed`) | as needed | PASS |
| APDM-P9 | PR #65 primitive merged (`8684c58ad1d494e60ffcfa15ab19ef1c67cce16c`); PR #66 evidence merged (`154b40873fec0886c4e2a25e67d6e644fe69ec4c`); PR #68 c4 promotion merged (`5d7f2ff0631402e143000af68c174f8c615a755a`) | not required | PASS |
| APDM-P10 | PR #67 implementation/hardening open; real OFF/ON c4 evidence still required | as needed | IN PROGRESS — blocked only on its own evidence gate |
| APDM-P11–P16 | not started | as needed | blocked by Phase 10 / preceding phases |

## Phase 5 closure

Phase 5 established the remote-authority cutover with deterministic rollback:

- `native` mode keeps SemApps native remote delivery;
- `external` mode creates zero SemApps native `remotePost` jobs and uses the durable `ap.delivery-plan.v1` handoff;
- the federation sidecar/Fedify path is the sole external ActivityPub HTTP executor in external mode;
- ActivityPods retains key custody and signing authority;
- the sidecar outbound boundary is DNS-aware, pins vetted resolution, disables redirects, and rejects unsafe destinations;
- exact-head CI and fresh Codex review were clean in both repositories before merge.

## Phase 6 closure

Phase 6 retired transitional duplicate recipient routing while preserving indexing and rollback semantics:

- ActivityPods no longer reconstructs remote recipients from raw Activity `to`/`cc`/`bto`/`bcc`, Follow targets, actor lookups, or shared-inbox inference in `outbox-emitter`;
- external delivery authority is bound end-to-end to one Delivery Plan intent ID across target markers, `X-APDM-Intent-Id`, metadata, and the durable sidecar intent;
- native rollback preserves Stream1/search observation through the targetless `/webhook/outbox-observation` path, which cannot create outbound federation jobs;
- external Delivery Plan handoffs and native observations use isolated durable intent namespaces, including protection from sidecar-owned `apdm-observation:` and `moderation-report:` identities;
- the non-production interoperability exception is provenance-scoped and validates the actual normalized delivery host;
- repository-owned load tests use per-run identities so retained idempotency state cannot silently suppress benchmark work;
- stale copied raw-routing integration code and operator instructions were removed;
- exact-head Fast Checks, full AP Interop Smoke, and fresh Codex review were clean before PR #30 merged; ActivityPods Backend Checks and fresh exact-head Codex review were clean before PR #27 merged.

## Phase 7 closure

Phase 7 removed the proven duplicate local account lookup without changing local storage semantics:

- the pinned `@semapps/activitypub@1.1.4` outbox still validates each local recipient once with `auth.account.findByWebId`;
- the already-resolved account-derived dataset is carried into `localPost()` through a request-local, non-enumerable Symbol-bound context on the exact in-memory Activity;
- `localPost()` consumes and removes that private context synchronously before its first await, so it is neither serialized into ActivityPub JSON nor shared across requests;
- the reviewed two-argument `localPost(recipients, activity)` seam remains unchanged, preserving the existing startup guard and external-authority interception wrapper;
- direct legacy `localPost()` callers retain the original account lookup fallback;
- inbox lookup/add, `ldp.remote.store`, activity attachment, recipient arrays, emitted semantics, and dataset/ACL boundaries remain unchanged;
- the install-time compatibility patch is pinned to SemApps 1.1.4, fails closed on version/source drift, and is available before `yarn install` in the production Docker dependency layer;
- exact-head Backend Checks run #145 patched the real published SemApps artifact and passed 46/46 suites, 376/376 tests, and the ATProto multibase smoke test;
- a fresh exact-head Codex review returned clean after the earlier three P1 findings were addressed.

## Phase 8 closure

Phase 8 completed the real local Tier 1 measurement/integrity work before concurrency changes were introduced:

- the real benchmark runner provisions Pod-backed local actors through normal ActivityPods signup/bootstrap paths;
- benchmark roots invoke the running backend's normal `activitypub.outbox.post` path;
- detached `localPost()` completion is correlated to each benchmark request so lower/partial fan-out cannot be admitted as a successful sample;
- caught per-recipient local delivery failures are surfaced to the measurement layer without changing SemApps fire-and-forget posting semantics;
- warm-restart readiness checks verify durable blocked/muted migration state through the real Moleculer → triplestore → Fuseki path before measurement;
- the required 1, 10, 100, 200 and 1,000-recipient matrix is represented by the Phase 8 runner and reconciliation artifacts;
- ActivityPods PR #30 merged after its Phase 8 correctness and execution gates were completed.

## Phase 9 closure

Phase 9 is complete. It introduced bounded scheduling first, measured it on the real local-delivery path, then promoted only the smallest empirically qualified concurrency:

- ActivityPods PR #65 layers a bounded worker pool on the pinned `@semapps/activitypub@1.1.4` `localPost()` implementation rather than creating a competing local-delivery path;
- `Promise.all()` is used only over the bounded worker set, never once per recipient;
- recipient-specific Pod dataset, inbox, LDP, WebACL and activity-attachment semantics remain on the existing SemApps path;
- concurrent physical completion does not leak into the `{ success, failures }` contract: results are reconstructed in original recipient order;
- canonical measurement run `31956939507` measured c1/c2/c4/c8 independently with fresh runner/Fuseki/Redis/backend state and separate 1,000-recipient Pod fixtures;
- every candidate contained three successful measured samples at N=1, 10, 100, 200 and 1,000 with zero failed samples;
- the original compare job failed only after measurement because of artifact-path handling; no candidate evidence was lost;
- PR #66 repaired the workflow so canonical raw JSONL evidence can be replayed without reprovisioning 4,000 Pods and hardened the selector to require matched samples, sustained large-N speedup, bounded CPU growth, and bounded action/Fuseki work drift;
- replay run `31964215322` passed and independently selected concurrency `4`;
- versus c1, c4 measured about `1.19x`, `1.21x`, and `1.34x` wall-clock speedup at N=100/200/1000, with CPU deltas around `-15.8%`, `-16.8%`, and `-25.1%`;
- c4 nested-action drift stayed around `-2.15%`, `-1.29%`, and `-0.19%`, while Fuseki-request drift stayed around `-2.18%`, `-1.24%`, and `-0.19%`, supporting the interpretation that Phase 9 improved scheduling rather than skipping persistence work;
- c2 failed the sustained `>=1.10x` gate at N=100 and N=200; c8 also failed it at N=100 and N=200 and was slower than c4 at every large size;
- PR #68 therefore promotes the normal unset `APDM_LOCAL_DELIVERY_CONCURRENCY` default to `4` while explicit `1` remains the rollback/serial mode;
- malformed, zero, negative, whitespace-padded, or unsafe explicit configuration fails safe to serial `1` rather than inheriting the parallel default;
- the hard runtime ceiling remains `32`;
- a second c4-promotion marker and exact migration path ensure already-patched c1 `node_modules` artifacts upgrade once; drifted legacy worker shapes fail closed instead of being partially rewritten;
- exact-head Backend Checks run `31964533972` passed the source transformer, installed published SemApps artifact, c1→c4 upgrade simulation, real in-flight c4 default, invalid-config serial fallback, and deterministic partial-failure regressions.

Phase 9 does not claim to remove the underlying per-recipient persistence/query amplification. The near-invariant action and Fuseki counts are exactly why Phase 10 and later persistence work remain necessary.

## Next gate

`APDM-P10-A` is now unblocked. Advance ActivityPods PR #67 onto the merged c4 Phase 9 baseline, keep the dataset-existence memo fail-closed by default, and run matched OFF/ON real local-fanout measurements at concurrency 4 for N=1, 10, 100, 200 and 1,000. The Phase 10 gate must review real correlated Fuseki `GET /$/datasets/{dataset}` traffic, total Fuseki work, delivery correctness, elapsed time, CPU, heap, LDP/WebACL behavior, and partial failures before any production-default promotion. Phase 11 remains blocked until Phase 10 closes.
