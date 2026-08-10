# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged | PR #9 merged | PASS |
| APDM-P2 | PR #15 merged | PR #10 merged | PASS |
| APDM-P3 | PR #16 merged | PR #11 merged | PASS |
| APDM-P4 | implementation/testing | idempotency proof/testing | pending crash/recovery proof, CI, review |
| APDM-P5 | not started | not started | blocked by P4 |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phases 0–3 — complete

- P0: federation PR #8 / ActivityPods PR #13 merged.
- P1: federation PR #9 / ActivityPods PR #14 merged; strict cross-repo `ap.delivery-plan.v1` contract established.
- P2: federation PR #10 / ActivityPods PR #15 merged; pre-`remotePost` native/external strategy seam established with native rollback default.
- P3: federation PR #11 / ActivityPods PR #16 merged; SemApps' already-expanded local/remote partition is now the authoritative Delivery Plan source.

Phase 3 gate evidence:
- ActivityPods Backend checks: PASS, including full unit suite and offline ATProto multibase smoke.
- Fedify Sidecar Fast Checks: PASS.
- AP Interop Smoke: PASS.
- no unresolved substantive review threads.
- paired followers-only producer/consumer fixture accepted in both repositories.

## Phase 4 — in progress

### APDM-P4-A — ActivityPods durable producer handoff

Branch: `apdm/phase-4-durable-handoff`

Implemented so far:
- adds a dedicated `deliveryHandoff` Bull queue on the strategy-aware SemApps outbox service;
- external preview requires a real `SEMAPPS_QUEUE_SERVICE_URL`; FakeQueue/in-memory fallback is rejected for durable handoff;
- the outbox action awaits Bull insertion before returning;
- the stable Delivery Plan `intentId` is used as the Bull job ID;
- queue processor maps authoritative `ap.delivery-plan.v1` remote targets to the sidecar's existing validated `/webhook/outbox` contract;
- the stable Delivery Plan ID and schema are preserved in event metadata;
- handoff worker throws on network/non-2xx/invalid acknowledgement so Bull retry/backoff owns recovery;
- worker accepts success only when the sidecar reports `accepted: true`, which occurs after Redis Streams `XADD` succeeds;
- the former P3 routing event name is no longer emitted, preventing the best-effort `outbox-emitter` listener from racing a second sidecar HTTP submission;
- native mode remains unchanged and production remote-authority cutover remains blocked until P5.

Producer tests cover:
- queue configuration fail-closed behavior;
- Delivery Plan -> sidecar webhook mapping;
- stable Bull job IDs;
- awaiting queue insertion before action success;
- insertion failure propagation;
- 202 durable acknowledgement handling;
- non-2xx retry behavior;
- invalid acknowledgement rejection;
- concurrent request isolation;
- preservation of native mode.

### APDM-P4-F — sidecar durable acceptance/idempotency proof

Branch: `apdm/phase-4-durable-handoff`

The current sidecar webhook already calls `queue.enqueueOutboxIntent(intent)` before sending HTTP 202, so its acknowledgement is after Redis Stream acceptance. The existing outbox-intent and outbound workers provide two additional recovery/idempotency layers:
- Redis Streams consumer-group pending-message recovery;
- deterministic outbound `jobId = activityId::deliveryUrl` plus `checkIdempotency()` before remote HTTP execution.

P4 adds tests proving that two separately accepted sidecar intents for the same Activity/target derive the same outbound job ID and that a duplicate outbound job is acknowledged without a second remote delivery.

### P4 gate still open: cross-store crash window

Activity persistence is authoritative in Fuseki/RDF while the producer retry job is durable in Redis/Bull. These are separate stores. The current branch closes the loss window **after Bull insertion**, but an abrupt process failure after Activity persistence and before Bull insertion is not yet proven recoverable.

P4 MUST NOT be marked complete until this cross-store gap is handled by an explicit recovery/reconciliation mechanism (or an equivalently strong proof) and crash-point tests demonstrate that persisted activities cannot permanently lose their remote handoff.

## Verified baseline carried forward

- exact SemApps 1.1.4 `getRecipients` expands the local actor's followers collection;
- exact 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`;
- exact 1.1.4 local delivery remains ActivityPods/Tier-1 authority;
- sidecar `OutboxIntentWorker` performs sharedInbox enrichment/deduplication before outbound fan-out;
- `enqueueOutboundBatchForIntent` atomically guards per-intent fan-out;
- `OutboundWorker` checks deterministic job-ID idempotency before remote HTTP execution.

## Open measurements (not architecture blockers)

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist.

These measurements remain scheduled for later APDM phases.
