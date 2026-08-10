# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 open | PR #9 open | pending contract tests/review |
| APDM-P2 | not started | fixture/support only | blocked by P1 |
| APDM-P3 | not started | fixture/support only | blocked by P2 |
| APDM-P4 | not started | not started | blocked by P3 |
| APDM-P5 | not started | not started | blocked by P4 |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phase 0 — complete

### APDM-P0-F — `outlaw-dame/mastopod-federation-architecture`

PR #8 merged. Authoritative program roadmap, contract ownership, invariants and status tracking established.

### APDM-P0-A — `outlaw-dame/activity-pods`

PR #13 merged. Exact SemApps 1.1.4 baseline and ActivityPods ownership/optimization responsibilities recorded.

## Phase 1 — in progress

### APDM-P1-F — `outlaw-dame/mastopod-federation-architecture`

Branch: `apdm/phase-1-delivery-plan-contract`

PR: #9 — `[APDM-P1-F] Add ActivityPub Delivery Plan v1 consumer contract`

Deliverables:
- strict Zod consumer parser;
- mirrored JSON Schema;
- shared compatibility fixture;
- fixture and schema SHA-256 drift detection;
- fail-closed version/target tests.

### APDM-P1-A — `outlaw-dame/activity-pods`

Branch: `apdm/phase-1-delivery-plan-contract`

PR: #14 — `[APDM-P1-A] Add ActivityPub Delivery Plan v1 producer contract`

Deliverables:
- producer JSON Schema and shared fixture;
- strict producer validation helper;
- fixture and schema SHA-256 drift detection;
- resolved local/remote target contract tests.

## Verified baseline carried forward

- `@semapps/activitypub` is pinned to 1.1.4 in ActivityPods.
- exact 1.1.4 `getRecipients` expands the local actor's followers collection.
- exact 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`.
- exact 1.1.4 `localPost` performs sequential recipient processing and repeats `auth.account.findByWebId`.
- the ActivityPods wrapper does not replace this outbox behavior.
- current ActivityPods `outbox-emitter` listens downstream of native job creation and does not itself expand `/followers`.
- sidecar `OutboxIntentWorker` supports sharedInbox enrichment and delivery-URL dedupe before batch enqueue.
- sidecar `OutboundWorker` uses bounded global/per-domain execution controls, retries, idempotency and DLQ handling.

## Open measurements (not architecture blockers)

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist.

These measurements are scheduled for later APDM phases and do not postpone the delivery-authority redesign.
