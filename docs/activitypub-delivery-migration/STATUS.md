# APDM Status

Last updated: 2026-08-10

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged | PR #9 merged | PASS |
| APDM-P2 | PR #15 merged | PR #10 merged | PASS |
| APDM-P3 | implementation/testing | paired consumer fixture/testing | pending CI/review |
| APDM-P4 | not started | not started | blocked by P3 |
| APDM-P5 | not started | not started | blocked by P4 |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Phases 0–2 — complete

- Phase 0: federation architecture PR #8 and ActivityPods PR #13 merged.
- Phase 1: federation PR #9 and ActivityPods PR #14 merged with cross-repo `ap.delivery-plan.v1` compatibility fingerprints and green AP interoperability checks.
- Phase 2: federation PR #10 and ActivityPods PR #15 merged. ActivityPods now owns a guarded pre-`remotePost` strategy seam, keeps `native` as the rollback default, and permits `external` only as explicitly guarded preview behavior.

Phase 2 gate evidence:
- ActivityPods full backend unit suite: PASS.
- Offline ATProto multibase smoke: PASS.
- no unresolved substantive review threads.
- external preview creates zero native SemApps `remotePost` jobs while native mode remains unchanged.

## Phase 3 — in progress

### APDM-P3-A — `outlaw-dame/activity-pods`

Branch: `apdm/phase-3-authoritative-recipient-planning`

Implemented on the branch:
- captures SemApps' already-expanded local recipient list at the existing `localPost` boundary;
- captures already-classified remote recipients at the pre-`remotePost` interception point;
- de-duplicates actor URIs without collapsing different actors sharing the same sharedInbox;
- rejects unresolved `/followers` collection URIs before target resolution;
- resolves concrete local actor/dataset/inbox metadata;
- resolves concrete remote actor/inbox/sharedInbox/domain metadata;
- performs target metadata resolution with configurable bounded concurrency (default 10);
- produces deterministic `apdm-v1-<sha256>` intent IDs from activity/actor/concrete-recipient identity;
- validates the resulting `ap.delivery-plan.v1` before emission;
- keeps SemApps local delivery unchanged;
- in external preview, ignores raw `activitypub.outbox.posted` as a routing authority and consumes the validated Delivery Plan event instead;
- in native mode, preserves the existing raw `outbox.posted` compatibility route.

Required Phase 3 test matrix now represented on the branch:
- followers-only addressing -> concrete local/remote followers;
- no unresolved `/followers` target survives planning;
- public and unlisted visibility;
- direct mention addressing;
- reply addressing;
- Follow addressing;
- deterministic intent IDs;
- fail-closed missing local dataset or remote inbox;
- measured resolver concurrency bound;
- external-mode legacy resolver suppression;
- native-mode compatibility;
- request-local interception concurrency isolation.

### APDM-P3-F — `outlaw-dame/mastopod-federation-architecture`

Branch: `apdm/phase-3-authoritative-recipient-planning`

Adds the paired followers-only consumer fixture. The same fixture fingerprint is pinned in both repositories:

`e166848b9d82e369fa6bace448dbd8ca42949aae9bdbba3b4034f0749d3d087c`

The raw Activity addresses only `https://pods.example/alice/followers`, while the Delivery Plan carries one concrete local follower and two concrete remote followers. This proves that collection addressing remains in the Activity semantics while remote execution receives individual resolved targets.

Phase 3 remains open until:
- ActivityPods backend CI passes the full suite;
- federation Fast Checks/contract tests pass;
- review threads are clear;
- the followers-only producer/consumer fixture is independently accepted by both repos.

## Verified baseline carried forward

- exact SemApps 1.1.4 `getRecipients` expands the local actor's followers collection;
- exact 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`;
- exact 1.1.4 `localPost` performs sequential recipient processing and repeats `auth.account.findByWebId`;
- sidecar `OutboxIntentWorker` supports sharedInbox enrichment and delivery-URL dedupe before batch enqueue;
- sidecar `OutboundWorker` uses bounded global/per-domain execution controls, retries, idempotency and DLQ handling.

## Open measurements (not architecture blockers)

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist.

These measurements are scheduled for later APDM phases and do not postpone the delivery-authority redesign.
