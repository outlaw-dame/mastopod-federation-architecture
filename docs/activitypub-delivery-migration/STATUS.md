# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged | PR #9 merged | PASS |
| APDM-P2 | PR #15 green | PR #10 current | PASS pending merge |
| APDM-P3 | not started | fixture/support only | blocked until P2 merge |
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

## Phase 2 — gate passed, merge pending

### APDM-P2-A — `outlaw-dame/activity-pods`

PR #15 — `[APDM-P2-A] Add pre-remotePost delivery strategy seam`

Verified behavior:
- `native` remains the default and delegates unchanged to SemApps;
- `external` is preview-only and requires a second explicit guard;
- external preview suppresses native `remotePost` job creation before queue insertion;
- unrelated queue work delegates normally;
- the interception context is request-local and does not mutate the shared Moleculer service instance;
- all required SemApps 1.1.4 deep package paths resolve;
- package drift from 1.1.4 fails fast;
- local delivery remains SemApps-owned and unchanged.

Gate evidence:
- Backend unit tests: PASS (217 tests after the Phase 2 additions).
- Offline ATProto multibase smoke: PASS.
- No unresolved review threads.

Two test-harness defects were found and corrected before the gate closed:
1. Jest initially executed an ESM-only crypto dependency while importing SemApps side-effects; tests now inject lightweight SemApps-shaped schemas while separately checking every production deep path with `require.resolve`.
2. A queue-delegation assertion omitted the explicit fourth `undefined` options argument; the assertion was corrected without changing production behavior.

### APDM-P2-F — `outlaw-dame/mastopod-federation-architecture`

PR #10 — `[APDM-P2-F] Track pre-remotePost strategy seam`

No sidecar runtime cutover occurs in Phase 2. This slice records the boundary and the passed gate. The sidecar remains non-authoritative until expanded-target planning and durable handoff are implemented.

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
