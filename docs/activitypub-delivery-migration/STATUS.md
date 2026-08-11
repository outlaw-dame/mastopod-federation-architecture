# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged | PR #9 merged | PASS |
| APDM-P2 | PR #15 merged | PR #10 merged | PASS |
| APDM-P3 | PR #16 merged | PR #11 merged | PASS |
| APDM-P4 | durable handoff + reconciliation implemented | duplicate-execution proof implemented | pending CI/final review |
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

## Phase 4 — implementation complete, gate pending

### APDM-P4-A — ActivityPods durable producer handoff

Branch: `apdm/phase-4-durable-handoff`

Implemented:
- dedicated `deliveryHandoff` Bull queue on the strategy-aware SemApps outbox service;
- external mode fails at service construction/startup unless the explicit migration guard, real `SEMAPPS_QUEUE_SERVICE_URL`, valid HTTP(S) handoff URL, and `SIDECAR_TOKEN` are present;
- FakeQueue/in-memory fallback is forbidden in external mode;
- the outbox action awaits Bull insertion before reporting successful handoff enqueue;
- the deterministic Delivery Plan `intentId` is the Bull job ID;
- an internal `activitypub.outbox.enqueueDeliveryHandoff` action lets reconciliation use exactly the same enqueue/idempotency path as live posts;
- queue processor maps authoritative `ap.delivery-plan.v1` remote targets to the existing sidecar `/webhook/outbox` contract;
- sidecar acceptance is considered durable only for HTTP 202 with `accepted: true` and a sidecar intent ID;
- network errors, 200/other non-202 responses, malformed JSON, and incomplete acknowledgements fail the Bull job so retry/backoff remains authoritative;
- stable APDM intent ID/schema stay in webhook metadata and `X-APDM-Intent-Id`;
- the old P3 routing event is not emitted; P4's `handoff-queued` event is observation-only and cannot trigger a second sidecar HTTP submission;
- native SemApps delivery remains unchanged and available as rollback until P5.

### Cross-store reconciliation

Fuseki persistence and Redis/Bull insertion are separate durability domains. P4 handles the process-crash window explicitly instead of pretending they are transactional.

`activitypub-delivery-reconciler`:
- runs only while APDM external mode is enabled;
- enumerates non-tombstoned ActivityPods accounts with bounded account concurrency;
- resolves each local actor's authoritative outbox and performs read-only SPARQL over the pod dataset for a bounded set of newest persisted Activities;
- refetches each Activity through SemApps and applies the configurable lookback cutoff in application code, avoiding assumptions about RDF date datatype representation;
- reruns exact SemApps `activitypub.activity.getRecipients` collection expansion;
- reclassifies local/remote recipients using the same provider boundary;
- rebuilds `ap.delivery-plan.v1` with the same deterministic intent algorithm;
- calls `activitypub.outbox.enqueueDeliveryHandoff`, therefore recreating the same Bull job ID if the original process died before queue insertion;
- skips local-only Activities;
- prevents overlapping reconciliation runs;
- exposes cumulative `getStats` counters for runs, accounts/activities scanned, handoffs requeued, failures, timestamps, and last error.

Producer tests cover:
- startup/config fail-fast behavior, including FakeQueue rejection;
- Delivery Plan -> sidecar mapping;
- stable Bull job IDs;
- waiting for queue insertion;
- insertion failure propagation;
- strict HTTP 202 durable acknowledgement semantics;
- generic 200/non-202 retry behavior;
- malformed/incomplete acknowledgement rejection;
- deterministic recipient-order-independent intent IDs;
- concurrent request isolation;
- persisted-Activity reconciliation;
- repeated reconciliation producing the same intent ID;
- local-only reconciliation suppression;
- overlap suppression and reconciliation counters;
- preservation of native mode.

### APDM-P4-F — sidecar durable acceptance/idempotency proof

Branch: `apdm/phase-4-durable-handoff`

The existing sidecar webhook calls `queue.enqueueOutboxIntent(intent)` before HTTP 202, so acknowledgement occurs after Redis Streams `XADD`. P4 carries the stable Delivery Plan ID in metadata even though the legacy webhook currently creates its own sidecar intent record ID.

P4 tests prove the important execution invariant despite response-loss retries:
- separately accepted sidecar intent records for one Activity/target derive the same deterministic outbound `jobId = activityId::deliveryUrl`;
- the stable `deliveryPlanIntentId` survives into outbound metadata;
- `OutboundWorker.checkIdempotency()` runs before remote HTTP;
- a duplicate outbound job is acknowledged without a second delivery.

Existing sidecar delivery metrics already include duplicate-delivery suppression (`deliveryDuplicatesSkipped`), while ActivityPods exposes reconciliation counters through the reconciler service.

### Remaining Phase 4 gate

P4 MUST NOT merge until:
- ActivityPods full backend unit suite passes;
- ActivityPods offline ATProto smoke passes;
- federation Fast Checks pass, including `DurableHandoffIdempotency.test.ts`;
- AP Interop Smoke passes;
- final manual diff review finds no unresolved correctness/security issues;
- review threads/comments, if any, are addressed.

## Verified baseline carried forward

- exact SemApps 1.1.4 `getRecipients` expands the local actor's followers collection;
- exact 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`;
- exact 1.1.4 local delivery remains ActivityPods/Tier-1 authority;
- sidecar `OutboxIntentWorker` performs sharedInbox enrichment/deduplication before outbound fan-out;
- `enqueueOutboundBatchForIntent` atomically guards per-intent fan-out;
- `OutboundWorker` checks deterministic job-ID idempotency before remote HTTP execution.

## Open measurements (not architecture blockers)

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist before P5 cutover.

These measurements remain scheduled for later APDM phases.
