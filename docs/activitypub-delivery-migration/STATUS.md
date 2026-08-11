# APDM Status

Last updated: 2026-08-11

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged; hardening PR #23 open | PR #9 merged; hardening PR #18 open | HARDENING IN PROGRESS; P5 blocked |
| APDM-P2 | PR #15 merged; hardening PR #22 merged | PR #10 merged; hardening PR #16 merged | PASS; post-merge hardening complete |
| APDM-P3 | PR #16 merged; hardening PR #21 merged | PR #11 merged; hardening PR #14 merged | PASS; post-merge hardening complete |
| APDM-P4 | PR #17 merged | PR #12 merged | PASS |
| APDM-P5 | not started | not started | BLOCKED by P1 privacy/interoperability hardening closeout |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Baseline Phases 0–4

- P0: federation PR #8 / ActivityPods PR #13 merged.
- P1 baseline: federation PR #9 / ActivityPods PR #14 merged; strict cross-repo `ap.delivery-plan.v1` contract established. A pre-P5 Codex-style retrospective is now active in ActivityPods PR #23 and federation PR #18.
- P2 baseline: federation PR #10 / ActivityPods PR #15 merged; pre-`remotePost` native/external strategy seam established with native rollback default. Post-merge hardening is complete through ActivityPods PR #22 and federation PR #16.
- P3: federation PR #11 / ActivityPods PR #16 merged; SemApps' already-expanded live local/remote partition is the authoritative Delivery Plan source.
- P3 post-merge hardening: federation PR #14 / ActivityPods PR #21 merged after Codex-level review; contract semantics, deterministic identity, visibility/privacy invariants, remote endpoint validation, and bounded target resolution were tightened without advancing remote-authority ownership to P5.
- P4: federation PR #12 / ActivityPods PR #17 merged; durable handoff and crash-safe duplicate suppression are complete.

## Phase 1 post-merge hardening — in progress

### Why this gate reopened

Before starting the Phase 5 production authority cutover, the already-merged Phase 1 contract was re-reviewed against the current P2–P4 implementation and exact SemApps 1.1.4 behavior. That review found contract/runtime discrepancies and privacy/interoperability issues important enough to reopen the Phase 1 gate rather than carrying them into production authority.

### ActivityPods producer hardening

PR: `outlaw-dame/activity-pods#23`

Implemented on the hardening branch:
- producer/consumer/schema agreement for `searchConsent` object-or-null semantics;
- fragment/credential/whitespace/control-character rejection for executable inbox endpoints;
- canonical lowercase `targetDomain` keyed from the effective delivery hostname with DNS trailing-dot aliases removed;
- fail-closed JSON fingerprint canonicalization for unsupported runtime values;
- sender-specific followers-address detection so unrelated actors named `/followers` are not misclassified;
- explicit recipient coverage checks so concrete actors are not silently dropped from the plan;
- blind-address sanitization: original `bto`/`bcc` values participate in routing, then are recursively removed from `Delivery Plan.activity` before durable external handoff;
- validator rejection of any hand-crafted outbound plan that still exposes `bto`/`bcc`;
- fail-closed handling for concrete `audience` recipients that SemApps 1.1.4 did not include in its captured partition;
- sender-followers via `audience` rejected until authoritative audience expansion exists;
- focused regression coverage for each invariant.

### Federation consumer hardening

PR: `outlaw-dame/mastopod-federation-architecture#18`

Implemented on the hardening branch:
- Zod consumer mirrors the producer's endpoint/domain/search-consent/fingerprint semantics;
- consumer rejects blind-address leakage anywhere in the outbound Activity;
- consumer checks explicit visible/audience recipient coverage against the resolved plan;
- consumer rejects sender-followers expressed through `audience` until ActivityPods provides authoritative expansion;
- authoritative contract documentation records blind-address, audience, and execution-security boundaries.

### Pre-Phase-5 privacy blocker

Exact SemApps 1.1.4 `activitypub.activity.getRecipients` scans `to`, `bto`, `cc`, and `bcc`, but the native outbox path continues with the same Activity object for persistence, local delivery, event emission, and native remote delivery. APDM's new Delivery Plan sanitization therefore protects the future ActivityPods -> Fedify boundary but does **not** by itself prove privacy for the native/local rollback path.

Before P5 starts, ActivityPods must close or conclusively prove unreachable the blind-address exposure across:
- persisted Activity representation;
- local Pod delivery;
- native rollback remote delivery;
- downstream event/observer payloads.

The fix must preserve blind recipients for routing before sanitization. Deleting `bto`/`bcc` before recipient discovery is not acceptable because it would silently lose intended recipients.

### Audience interoperability blocker

ActivityPub outbox delivery includes `audience`, while exact SemApps 1.1.4 recipient discovery scans only `to`, `bto`, `cc`, and `bcc`. Until authoritative audience expansion exists, APDM fails closed on a concrete `audience` actor missing from the captured partition and on the sender's followers collection expressed only through `audience`.

### Phase 1 hardening exit gate

P1 hardening returns to PASS only when:
1. ActivityPods backend tests and offline ATProto smoke pass on the final PR head;
2. Fedify Fast Checks and AP Interop Smoke pass on the final federation PR head;
3. producer, JSON Schema, and Zod consumer remain cross-repo compatible;
4. no unresolved substantive review threads/comments remain;
5. blind-address sanitization is proven at the external Delivery Plan boundary;
6. the broader SemApps native/local blind-address exposure has a tested fix or an explicit proof that the affected path cannot occur;
7. `audience` behavior has a safe production policy (authoritative expansion or explicit fail-closed cutover guard);
8. final manual/Codex-style diff review finds no remaining P1 blocker.

P5 MUST NOT start while this gate is open.

## Phase 2 post-merge hardening — complete

### ActivityPods interception seam

PR: `outlaw-dame/activity-pods#22`
Merge commit: `0759877385c756d5d2a8ba82ceb209b69ee595aa`

Implemented and verified:
- exact `@semapps/activitypub` 1.1.4 version pin and deep-import checks;
- critical `getRecipients -> remotePost creation -> activitypub.outbox.posted -> localPost` interception ordering validation;
- fail-closed suppressed `remotePost` structure validation;
- localPost observation accumulation and native local behavior preservation;
- strict mode/preview/handoff configuration validation;
- service-registration parity regression coverage.

Final gate evidence:
- Backend Checks passed on final head `24fa4f799d2e7c24d4f3ab7a418f542624b6e306`;
- stable backend unit lane and offline ATProto multibase smoke passed;
- substantive Codex findings were fixed and resolved;
- PR #22 squash-merged as `0759877385c756d5d2a8ba82ceb209b69ee595aa`.

### Federation architecture companion

PR: `outlaw-dame/mastopod-federation-architecture#16`
Merge commit: `032af9e0e66a723c7b7a13e720514c97e4288d1b`

The federation-side hardening records ActivityPods interception guarantees without changing sidecar runtime behavior. P2 hardening is PASS.

## Phase 3 post-merge hardening — complete

### ActivityPods producer hardening

PR: `outlaw-dame/activity-pods#21`
Merge commit: `f53293261382a3027f492649a9ec36056041c7ae`

Verified hardening includes deterministic intent IDs, Activity/envelope identity agreement, visibility/public metadata invariants, recipient uniqueness/local-vs-remote exclusion, credential rejection, target-domain consistency, and one global target-resolution concurrency budget. Backend CI and offline ATProto smoke passed with no unresolved review items.

### Federation consumer hardening

PR: `outlaw-dame/mastopod-federation-architecture#14`
Merge commit: `ab56a201c639eb3f28453ca36732383154f41c88`

The TypeScript/Zod contract mirrors the producer invariants and passed Fedify Fast Checks + AP Interop Smoke after its Codex findings were resolved.

### Supporting lockfile reconciliation

ActivityPods PRs #18 and #20 reconciled the backend lockfile with the package.json-pinned SemApps 1.1.4 graph and Yarn v1 canonical Git dependency form.

## Phase 4 — complete

### APDM-P4-A — ActivityPods durable producer handoff

PR: `outlaw-dame/activity-pods#17`
Merge commit: `f08babc9bbf0a335e50cdb9bf217dd273e272bd6`

Implemented and verified:
- dedicated deterministic Bull `deliveryHandoff` queue;
- fail-fast external-mode configuration and no FakeQueue fallback;
- strict sidecar HTTP 202 durable-acceptance contract;
- observation-only handoff event;
- persisted-outbox reconciler closing the Fuseki -> Bull permanent-loss window;
- rotating/paged bounded reconciliation, distributed lease, counters, and deterministic recovery IDs;
- native SemApps rollback remains intact.

### APDM-P4-F — sidecar durable acceptance

PR: `outlaw-dame/mastopod-federation-architecture#12`
Merge commit: `c7d28a80d1aacc86692daada7bf8333a4cd27a97`

The sidecar acknowledges only after Redis Streams acceptance. Duplicate accepted intents converge on deterministic outbound job IDs, and the worker separates temporary in-flight claims from durable completed-delivery markers so stale/dead-worker claims do not suppress delivery.

### Phase 4 gate evidence

Both P4 PRs merged with their required CI/interoperability lanes green and all substantive review threads resolved. Production remote-authority cutover remained deliberately deferred to P5.

## Verified baseline carried forward

- exact SemApps 1.1.4 `getRecipients` expands the local actor's followers collection from `to`/`bto`/`cc`/`bcc` but does not process `audience`;
- exact SemApps 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`;
- exact 1.1.4 local delivery remains ActivityPods/Tier-1 authority;
- sidecar `OutboxIntentWorker` performs sharedInbox enrichment/deduplication before outbound fan-out;
- `enqueueOutboundBatchForIntent` atomically guards per-intent fan-out;
- deterministic outbound job IDs converge duplicate accepted intents onto the same Activity+delivery target identity.

## Open measurements / later hardening

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist before P5 cutover;
- optional historical recipient-snapshot persistence if exact follower membership at the original post instant is required across the Fuseki-to-Bull crash boundary.

These remain explicit follow-up work. They are separate from the reopened P1 blind-address/audience gate described above.
