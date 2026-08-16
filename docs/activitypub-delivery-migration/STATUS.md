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
| APDM-P9 | PR #65 merged (`8684c58ad1d494e60ffcfa15ab19ef1c67cce16c`) | not required for primitive | IN PROGRESS — bounded primitive merged; comparative tuning/default selection remains |
| APDM-P10–P16 | not started | as needed | blocked by Phase 9 evidence gate / preceding phases |

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

## Phase 9 current state

Phase 9 has now landed the bounded scheduling primitive but is deliberately not marked fully complete yet:

- ActivityPods PR #65 layers a second fail-closed patch on the pinned `@semapps/activitypub@1.1.4` local-delivery implementation rather than creating a competing delivery path;
- `APDM_LOCAL_DELIVERY_CONCURRENCY` controls a fixed-size recipient worker pool;
- the current default is `1`, preserving the previously measured serial behavior;
- malformed, zero, negative and unsafe integer configuration values fail safe to `1`;
- the runtime hard-clamps concurrency to `32`;
- `Promise.all()` is used only over the bounded worker set, never once per recipient;
- recipient-specific Pod dataset, inbox, LDP, WebACL and activity-attachment semantics remain on the existing SemApps path;
- concurrent completion does not leak into the `{ success, failures }` contract: results are reconstructed in original recipient order;
- exact-head Backend Checks for PR #65 passed dependency installation/postinstall patching, lockfile drift checks, stable backend unit tests including concurrency/failure-order regressions, and the offline ATProto multibase smoke test;
- the fresh Codex request was quota-blocked and therefore was not treated as independent review approval; no actionable review thread was present.

## Next gate

Complete the Phase 9 evidence step before changing the production default above `1`: rerun the real Phase 8 local-fanout matrix with representative bounded concurrency values and compare wall-clock latency, CPU, heap, nested Moleculer calls, Fuseki/SPARQL work, WebACL/LDP work, and partial-failure correctness. Choose a higher default only if the measurements show a material latency improvement without unacceptable Fuseki/heap pressure or semantic regression.
