# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged | PR #9 merged | PASS |
| APDM-P2 | PR #15 merged | PR #10 merged | PASS |
| APDM-P3 | PR #16 merged | PR #11 merged | PASS |
| APDM-P4 | PR #17 ready | PR #12 ready | implementation/review complete; final CI after docs update |
| APDM-P5 | not started | not started | blocked by P4 merge |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phases 0–3 — complete

- P0: federation PR #8 / ActivityPods PR #13 merged.
- P1: federation PR #9 / ActivityPods PR #14 merged; strict cross-repo `ap.delivery-plan.v1` contract established.
- P2: federation PR #10 / ActivityPods PR #15 merged; pre-`remotePost` native/external strategy seam established with native rollback default.
- P3: federation PR #11 / ActivityPods PR #16 merged; SemApps' already-expanded live local/remote partition is the authoritative Delivery Plan source.

## Phase 4 — implementation and review complete

### APDM-P4-A — ActivityPods durable producer handoff

PR: `outlaw-dame/activity-pods#17`

Implemented:
- dedicated `deliveryHandoff` Bull queue on the strategy-aware SemApps outbox service;
- external mode fails at construction/startup unless the explicit migration guard, real `SEMAPPS_QUEUE_SERVICE_URL`, valid HTTP(S) handoff URL, and `SIDECAR_TOKEN` are present;
- FakeQueue/in-memory fallback is forbidden in external mode;
- the outbox action waits for Bull insertion before reporting successful handoff enqueue;
- Bull uniqueness uses deterministic `deliveryPlan.intentId` as `opts.jobId`;
- an internal `activitypub.outbox.enqueueDeliveryHandoff` action lets reconciliation reuse the exact live enqueue path;
- queue processor maps authoritative `ap.delivery-plan.v1` targets to the sidecar `/webhook/outbox` contract;
- sidecar acceptance is durable only for HTTP 202 with `accepted: true` and a sidecar intent ID;
- network errors, 200/other non-202 responses, malformed JSON, and incomplete acknowledgements fail the Bull job so retry/backoff remains authoritative;
- the stable APDM intent ID/schema stay in webhook metadata and `X-APDM-Intent-Id`;
- the old P3 routing event is not emitted; P4's `handoff-queued` event is observation-only;
- native SemApps delivery remains unchanged and is the rollback path until P5.

### Cross-store reconciliation

Fuseki persistence and Redis/Bull insertion remain separate durability domains. P4 explicitly repairs the crash window instead of treating them as transactional.

`activitypub-delivery-reconciler`:
- runs only while APDM external mode is enabled;
- rotates through provider accounts using a Redis-persisted account cursor rather than repeatedly scanning the first page;
- uses a token-safe distributed Redis lease so only one provider process advances reconciliation at a time;
- resolves each local actor's authoritative outbox and performs read-only SPARQL over the pod dataset;
- pages through the configured activity lookback rather than revisiting only the newest fixed batch;
- refetches each Activity through SemApps and applies the lookback cutoff in application code;
- expands unresolved local followers collections to concrete actors and refuses unresolved remote followers collections;
- reclassifies concrete local/remote recipients using the provider boundary;
- rebuilds `ap.delivery-plan.v1` using the deterministic intent algorithm;
- calls `activitypub.outbox.enqueueDeliveryHandoff`, recreating the same Bull job ID for the same reconstructed audience;
- skips local-only Activities;
- exposes cumulative counters including cursor position and distributed-lock skips.

Important recovery boundary: a followers-addressed persisted Activity normally contains the followers collection URI, not a historical concrete-recipient snapshot. If recovery occurs after a crash before Bull insertion, the reconciler expands the authoritative followers collection as it exists at recovery time. This closes permanent handoff loss but is not a historical audience snapshot or a Fuseki+Redis distributed transaction. Exact historical recipient snapshotting remains a potential later hardening item and must not be inferred from P4.

### APDM-P4-F — sidecar durable acceptance and crash-safe duplicate suppression

PR: `outlaw-dame/mastopod-federation-architecture#12`

The sidecar webhook acknowledges only after Redis Streams acceptance. Separate accepted sidecar intents for the same Activity and target still converge on deterministic outbound `jobId = activityId::deliveryUrl`.

Phase 4 replaces the unsafe pre-send idempotency interpretation with distinct states:

```text
Redis Stream message
      |
      v
temporary in-flight claim
      |
      v
remote HTTP delivery
      |
      v
durable completed marker
      |
      v
XACK
```

Properties:
- an in-flight claim is never proof of completed delivery;
- stale claims expire, allowing reclaimed messages to become deliverable;
- live claims cause durable defer/requeue before the current message is acknowledged;
- only the completed marker suppresses a duplicate;
- claim release is ownership-token checked;
- successful HTTP is followed by completed-marker persistence before Stream acknowledgement;
- if completed-marker persistence fails after HTTP success, the message is left pending rather than silently lost;
- retry/defer replacement work is inserted before the old Stream message is acknowledged.

Tests prove deterministic job convergence, stale/dead-worker claim recovery, delivery after claim expiry, and duplicate suppression only after completed state.

## Phase 4 gate evidence

ActivityPods PR #17:
- Backend checks: PASS on the latest executable-code head before the final documentation-only update;
- full stable backend unit lane passed;
- offline ATProto multibase smoke passed as part of the workflow;
- all four substantive review threads were fixed and resolved.

Federation PR #12:
- Fedify Sidecar Fast Checks passed on the crash-safe claim-store/test head;
- AP Interop Smoke passed on the preceding crash-safe worker head and is rerun after the final documentation/test updates;
- the P1 review about pre-send claims being mistaken for completed delivery was fixed in production code and regression-tested, then resolved.

Final merge gate: both PR heads must have green current CI after the documentation updates and no new unresolved substantive review threads. After that P4 may merge; production remote-authority cutover still belongs to P5.

## Verified baseline carried forward

- exact SemApps 1.1.4 `getRecipients` expands the local actor's followers collection;
- exact 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`;
- exact 1.1.4 local delivery remains ActivityPods/Tier-1 authority;
- sidecar `OutboxIntentWorker` performs sharedInbox enrichment/deduplication before outbound fan-out;
- `enqueueOutboundBatchForIntent` atomically guards per-intent fan-out;
- deterministic outbound job IDs converge duplicate accepted intents onto the same Activity+delivery target identity.

## Open measurements / later hardening (not P4 merge blockers)

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist before P5 cutover;
- optional historical recipient-snapshot persistence if exact follower membership at the original post instant is required across the Fuseki-to-Bull crash boundary;
- backend `yarn.lock` dependency drift warning in ActivityPods CI should be reconciled separately; the current Phase 4 backend workflow passes despite that pre-existing warning.

These remain explicit follow-up work rather than hidden assumptions in the P4 durability claim.
