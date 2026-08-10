# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged | PR #9 merged | PASS |
| APDM-P2 | in progress | support/status only | pending strategy tests/review |
| APDM-P3 | not started | fixture/support only | blocked by P2 |
| APDM-P4 | not started | not started | blocked by P3 |
| APDM-P5 | not started | not started | blocked by P4 |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phase 0 — complete

- Federation architecture PR #8 merged.
- ActivityPods PR #13 merged.

## Phase 1 — complete

- Federation architecture PR #9 merged: strict `ap.delivery-plan.v1` consumer contract, mirrored schema/fixture, SHA-256 drift detection, and interop image correction required to restore the AP smoke lane.
- ActivityPods PR #14 merged: strict producer schema/fixture, validation helper, and cross-repo compatibility fingerprints.

Phase 1 gate evidence:
- ActivityPods Backend checks: PASS.
- Fedify Sidecar Fast Checks: PASS.
- AP Interop Smoke: PASS after replacing the Alpine interop Node image with a glibc-compatible Node 22 Bookworm image required by `onnxruntime-node`.
- No substantive review threads remained on either P1 PR.

## Phase 2 — in progress

### APDM-P2-A — `outlaw-dame/activity-pods`

Branch: `apdm/phase-2-remote-delivery-strategy`

Primary goals:
- insert the remote-delivery strategy seam before SemApps native `remotePost` job creation;
- retain `native` mode as the default rollback path;
- expose `external` only behind an explicit preview guard until durable handoff exists;
- suppress native `remotePost` creation in external preview mode without mutating the shared Moleculer service instance;
- pin the adapter to exact `@semapps/activitypub` 1.1.4 so dependency upgrades fail fast pending outbox review.

### APDM-P2-F — `outlaw-dame/mastopod-federation-architecture`

Branch: `apdm/phase-2-remote-delivery-strategy`

No federation runtime cutover occurs in Phase 2. The federation slice records the contract boundary and preserves the Phase 1 consumer contract while ActivityPods establishes the pre-`remotePost` seam. The sidecar remains non-authoritative until the expanded-target and durable-handoff phases.

## Verified baseline carried forward

- exact SemApps 1.1.4 `getRecipients` expands the local actor's followers collection;
- exact 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`;
- exact 1.1.4 `localPost` performs sequential recipient processing and repeats `auth.account.findByWebId`;
- current ActivityPods `outbox-emitter` listens downstream of native job creation and does not itself expand `/followers`;
- sidecar `OutboxIntentWorker` supports sharedInbox enrichment and delivery-URL dedupe before batch enqueue;
- sidecar `OutboundWorker` uses bounded global/per-domain execution controls, retries, idempotency and DLQ handling.

## Open measurements (not architecture blockers)

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist.

These measurements are scheduled for later APDM phases and do not postpone the delivery-authority redesign.
