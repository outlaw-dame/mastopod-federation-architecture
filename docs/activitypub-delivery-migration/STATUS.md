# APDM Status

Last updated: 2026-08-11

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged | PR #9 merged | PASS |
| APDM-P2 | PR #15 merged; hardening PR #22 in review | PR #10 merged; hardening PR #16 in review | HARDENING IN PROGRESS |
| APDM-P3 | PR #16 merged; hardening PR #21 merged | PR #11 merged; hardening PR #14 merged | PASS; post-merge hardening complete |
| APDM-P4 | PR #17 merged | PR #12 merged | PASS |
| APDM-P5 | not started | not started | blocked by P2 hardening closeout; P4 prerequisites otherwise pass |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |
| APDM-P14 | support as needed | not started | may follow P6; final proof in P15 |
| APDM-P15 | not started | not started | blocked by implementation phases |
| APDM-P16 | not started | not started | blocked by P15 |

## Baseline Phases 0–4

- P0: federation PR #8 / ActivityPods PR #13 merged.
- P1: federation PR #9 / ActivityPods PR #14 merged; strict cross-repo `ap.delivery-plan.v1` contract established.
- P2 baseline: federation PR #10 / ActivityPods PR #15 merged; pre-`remotePost` native/external strategy seam established with native rollback default. Its post-merge hardening gate is currently reopened by PRs #22/#16 and must close before P5.
- P3: federation PR #11 / ActivityPods PR #16 merged; SemApps' already-expanded live local/remote partition is the authoritative Delivery Plan source.
- P3 post-merge hardening: federation PR #14 / ActivityPods PR #21 merged after Codex-level review; contract semantics, deterministic identity, visibility/privacy invariants, remote endpoint validation, and bounded target resolution were tightened without advancing remote-authority ownership to P5.
- P4: federation PR #12 / ActivityPods PR #17 merged; durable handoff and crash-safe duplicate suppression are complete.

## Phase 2 post-merge hardening — in progress

### ActivityPods interception seam

PR: `outlaw-dame/activity-pods#22`
Status: implementation complete on the PR head; final merge/review closeout pending.

Hardening under review:
- preserve the exact `@semapps/activitypub` 1.1.4 version pin and deep-import checks;
- verify the installed SemApps outbox still has the critical `getRecipients -> remotePost creation -> activitypub.outbox.posted -> localPost` shape before enabling the adapter;
- validate suppressed `remotePost` structure synchronously at the intercepted `createJob` boundary so malformed jobs fail before later SemApps outbox events/local delivery can run;
- require a safe concrete HTTP(S) recipient URI, SemApps-compatible job identity, and concrete Activity ID/actor on every suppressed remote job;
- verify captured remote/local Activity identity against the Activity returned by the outbox handler;
- accumulate every `localPost` observation instead of overwriting an earlier call;
- preserve native `localPost` execution and native-mode rollback behavior;
- reject empty/ambiguous delivery-mode values rather than silently coercing them;
- require a boolean external-preview guard rather than truthy coercion;
- reject malformed, credential-bearing, fragment-bearing handoff URLs, blank tokens, and handoff timeouts that are non-integer or outside 100–60000 ms;
- prove the ActivityPods adapter still registers the complete SemApps 1.1.4 ActivityPub subservice set exactly once.

Current gate evidence:
- an earlier hardening head passed Backend Checks;
- Codex found a valid P2 fractional-timeout issue; it was fixed with integer startup validation and regression coverage;
- a later manual review moved malformed remote-job structural rejection to the intercepted `createJob` call, before downstream outbox effects;
- the final backend gate and fresh Codex review must pass before this section can be marked complete.

### Federation architecture companion

PR: `outlaw-dame/mastopod-federation-architecture#16`
Status: documentation/review gate in progress; no Fedify runtime change.

The federation side records these ActivityPods interception guarantees as prerequisites for later remote-authority cutover. Phase 4 remains the durable acceptance boundary and Phase 5 remains the explicit production-authority transition.

P5 is intentionally blocked while this hardening gate is open.

## Phase 3 post-merge hardening — complete

### ActivityPods producer hardening

PR: `outlaw-dame/activity-pods#21`
Merge commit: `f53293261382a3027f492649a9ec36056041c7ae`

Implemented and verified:
- deterministic `apdm-v1-<sha256>` intent IDs are validated, not merely generated;
- the Delivery Plan envelope must agree with the embedded Activity ID and actor;
- visibility is independently derived from normalized ActivityPub `to` / `cc` addressing, including object-valued `id` / `@id` references;
- `isPublicActivity` must agree with addressing-derived visibility;
- followers/direct Activities cannot claim `isPublicIndexable: true`;
- duplicate recipient actor identities are rejected and one actor cannot appear in both local and remote recipient sets;
- remote inbox/sharedInbox URLs reject non-HTTP(S) protocols and embedded credentials;
- `targetDomain` must equal the hostname of the effective sharedInbox/inbox URL;
- local and remote resolution share one global bounded concurrency budget rather than independent per-class budgets;
- shared fixtures use their real deterministic intent IDs;
- the outbox-emitter regression fixture computes the canonical intent ID instead of using a structurally valid placeholder.

Final ActivityPods gate evidence:
- Backend Checks passed on the current-master replay PR;
- 30/30 backend suites and 269/269 tests passed;
- offline ATProto multibase smoke passed;
- the normal backend install produced no `yarn.lock` drift warning;
- no unresolved review threads, review submissions, or PR comments remained.

### Federation consumer hardening

PR: `outlaw-dame/mastopod-federation-architecture#14`
Merge commit: `ab56a201c639eb3f28453ca36732383154f41c88`

Implemented and verified:
- the TypeScript/Zod contract mirrors deterministic intent-ID, Activity/envelope identity, visibility/public metadata, recipient uniqueness, and target-domain invariants;
- malformed or credential-bearing federation URLs fail validation without escaping as parser exceptions;
- the Codex P1 finding about an unguarded `new URL()` inside `superRefine()` was fixed with a non-throwing URL parser and regression coverage;
- the contract parser remains explicitly documented as a cross-repo compatibility artifact under the current P4 webhook mapping, not yet the live network trust boundary.

Final federation gate evidence:
- Fedify Sidecar Fast Checks passed;
- AP Interop Smoke passed;
- the P1 review thread was fixed and resolved;
- ActivityPods and federation `master` carry matching Delivery Plan fixture and JSON-schema fingerprints.

### Lockfile reconciliation supporting the hardening review

The pre-existing ActivityPods backend lockfile drift discovered during Phase 4 is resolved:
- PR #18 regenerated the stale SemApps dependency graph from 1.1.2 to the package.json-pinned 1.1.4 set and merged as `a7aee8abc9765cfc2f7a90aec6619a7ceb97ec5a`;
- PR #20 applied the remaining Yarn v1 canonical form for the public `node-cas` Git dependency and merged as `a8ddaddaa18aa330dc808eb2e84b4d984e6e3578`;
- the final Phase 3 hardening CI run inherited that lockfile unchanged and emitted no lockfile drift warning.

## Phase 4 — complete

### APDM-P4-A — ActivityPods durable producer handoff

PR: `outlaw-dame/activity-pods#17`
Merge commit: `f08babc9bbf0a335e50cdb9bf217dd273e272bd6`

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
Merge commit: `c7d28a80d1aacc86692daada7bf8333a4cd27a97`

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

## Phase 4 gate evidence — PASS

ActivityPods PR #17:
- merged as `f08babc9bbf0a335e50cdb9bf217dd273e272bd6`;
- final Backend Checks passed on the documentation-updated PR head;
- full stable backend unit lane passed;
- offline ATProto multibase smoke passed as part of the workflow;
- all four substantive review threads were fixed and resolved.

Federation PR #12:
- merged as `c7d28a80d1aacc86692daada7bf8333a4cd27a97`;
- final Fedify Sidecar Fast Checks passed;
- final AP Interop Smoke passed, including the AP interop smoke lane;
- the P1 review about pre-send claims being mistaken for completed delivery was fixed in production code, regression-tested, and resolved.

Final manual diff review found no unresolved Phase 4 correctness/security blocker. Production remote-authority cutover remains deliberately deferred to P5.

## Verified baseline carried forward

- exact SemApps 1.1.4 `getRecipients` expands the local actor's followers collection;
- exact 1.1.4 outbox partitions recipients and creates native `remotePost` jobs before `activitypub.outbox.posted`;
- exact 1.1.4 local delivery remains ActivityPods/Tier-1 authority;
- sidecar `OutboxIntentWorker` performs sharedInbox enrichment/deduplication before outbound fan-out;
- `enqueueOutboundBatchForIntent` atomically guards per-intent fan-out;
- deterministic outbound job IDs converge duplicate accepted intents onto the same Activity+delivery target identity.

## Open measurements / later hardening — not P4 blockers

- measured nested Tier 1 operation count behind the source-counted top-level local fan-out calls;
- runtime duplicate-HTTP frequency while native and sidecar paths coexist before P5 cutover;
- optional historical recipient-snapshot persistence if exact follower membership at the original post instant is required across the Fuseki-to-Bull crash boundary.

These remain explicit follow-up work rather than hidden assumptions in the P4 durability claim. The backend lockfile drift item previously listed here is resolved by ActivityPods PRs #18 and #20.
