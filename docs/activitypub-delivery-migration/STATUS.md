# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 open | PR #8 open | pending paired PR review |
| APDM-P1 | not started | not started | blocked by P0 |
| APDM-P2 | not started | fixture/support only | blocked by P1 |
| APDM-P3 | not started | fixture/support only | blocked by P2 |
| APDM-P4 | not started | not started | blocked by P3 |
| APDM-P5 | not started | not started | blocked by P4 |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phase 0 paired work

### APDM-P0-F — `outlaw-dame/mastopod-federation-architecture`

Branch: `apdm/phase-0-cross-repo-baseline`

PR: #8 — `[APDM-P0-F] Establish cross-repo ActivityPub delivery migration program`

Deliverables:
- authoritative program README;
- ordered PHASES roadmap;
- cross-repo CONTRACT ownership definition;
- INVARIANTS and rollback requirements;
- this live STATUS tracker.

### APDM-P0-A — `outlaw-dame/activity-pods`

Branch: `apdm/phase-0-cross-repo-baseline`

PR: #13 — `[APDM-P0-A] Record ActivityPods ActivityPub delivery baseline`

Deliverables:
- ActivityPods-specific delivery baseline and SemApps 1.1.4 divergence/ownership note;
- link to authoritative program in federation architecture repo;
- source-counted local fan-out baseline and explicit unresolved instrumentation questions.

## Verified baseline carried into P0

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

These measurements are explicitly scheduled later and are not used to postpone the already-supported delivery-authority redesign.
