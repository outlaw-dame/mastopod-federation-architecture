# APDM Status

Last updated: 2026-08-14

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
| APDM-P8 | next: nested Tier 1 instrumentation | as needed | READY |
| APDM-P9–P16 | not started | as needed | blocked by preceding local-fan-out phases |

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

## Next phase

`APDM-P8-A` is now unblocked. Its scope is measurement, not optimization: instrument the real local Tier 1 hot path at 1, 10, 100, 200 and 1,000 local recipients and reconcile measured nested Moleculer, Fuseki/SPARQL, WebACL, LDP, elapsed-time, CPU and heap work with the source-counted model before changing concurrency or persistence behavior.
