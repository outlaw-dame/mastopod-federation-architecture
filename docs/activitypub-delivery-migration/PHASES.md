# APDM Phases

This is the ordered cross-repository ActivityPub Delivery Migration roadmap. `STATUS.md` carries the detailed evidence ledger.

## Completion rule

A checked phase means its **exit gate is closed**: required implementation, compatibility/correctness work, empirical evidence where required, and merge gates are complete. A merged preparatory PR by itself does not complete a phase.

Supporting scalability, FEP, security, identity, queue, media, or interoperability work may strengthen APDM without advancing the phase number unless it is explicitly part of that phase's exit gate.

## Program checklist

- [x] Phase 0 — Cross-repo baseline and authority
- [x] Phase 1 — Delivery Plan v1 contract
- [x] Phase 2 — Pre-`remotePost` delivery-strategy seam
- [x] Phase 3 — Authoritative expanded recipient planning
- [x] Phase 4 — Durable ActivityPods → sidecar handoff
- [x] Phase 5 — Fedify remote-authority cutover
- [x] Phase 6 — Remove transitional duplicate routing
- [x] Phase 7 — Local fan-out low-risk waste removal
- [x] Phase 8 — Nested Tier 1 instrumentation and real cost model
- [x] Phase 9 — Bounded local concurrency and empirical default selection
- [ ] Phase 10 — Local metadata round-trip reduction — **IN PROGRESS**
- [ ] Phase 11 — Batch-safe local persistence — blocked by Phase 10
- [ ] Phase 12 — Durable local fan-out and partial-failure recovery
- [ ] Phase 13 — Canonical bridge convergence
- [ ] Phase 14 — Shared-inbox hardening
- [ ] Phase 15 — End-to-end load, fault and interoperability proof
- [ ] Phase 16 — Stabilization and migration cleanup

## Phase 0 — Cross-repo baseline and authority

**Status:** PASS  
**Slices:** `APDM-P0-A`, `APDM-P0-F`

Goals:
- freeze the verified SemApps 1.1.4 delivery call graph;
- document repository ownership and migration boundaries;
- establish shared phase identifiers, invariants, status tracking and acceptance gates;
- make no runtime delivery behavior changes.

Exit gate:
- [x] both repos contain linked Phase 0 documentation;
- [x] no disagreement about then-current local/remote behavior or ownership;
- [x] subsequent APDM PRs use shared phase identifiers.

Evidence: ActivityPods PR #13; federation PR #8.

## Phase 1 — Delivery Plan v1 contract

**Status:** PASS  
**Slices:** `APDM-P1-A`, `APDM-P1-F`

Define a versioned contract carrying the persisted Activity plus authoritative resolved delivery targets. Recipient expansion occurs once inside ActivityPods/SemApps authority.

Required data:
- stable schema/version;
- activity ID and actor URI;
- immutable Activity payload;
- local targets with actor URI, dataset and inbox URI;
- remote targets with actor URI, inbox URL, optional sharedInbox URL and target domain;
- visibility/search-consent metadata needed by downstream workers;
- stable intent/idempotency material.

Exit gate:
- [x] producer and consumer fixtures pass byte/semantic compatibility tests in both repos;
- [x] post-merge contract hardening is incorporated without changing v1 authority semantics.

Evidence: ActivityPods PRs #14/#23; federation PRs #9/#18.

## Phase 2 — Pre-`remotePost` delivery-strategy seam

**Status:** PASS  
**Primary:** `APDM-P2-A`; paired contract/hardening in federation repo.

Introduce an ActivityPods/SemApps integration seam before native `remotePost` job creation, with native rollback and guarded external mode.

Exit gate:
- [x] external preview creates zero SemApps `remotePost` jobs;
- [x] local delivery behavior remains on the SemApps path;
- [x] native rollback remains tested;
- [x] exact SemApps 1.1.4 seam assumptions fail closed on drift.

Evidence: ActivityPods PRs #15/#22; federation PRs #10/#16/#17.

## Phase 3 — Authoritative expanded recipient planning

**Status:** PASS  
**Primary:** `APDM-P3-A`; consumer fixtures in `APDM-P3-F`.

Reuse SemApps `getRecipients` output instead of making the sidecar independently re-parse Activity addressing. Preserve local/remote classification and resolved metadata in the Delivery Plan.

Exit gate:
- [x] followers-only addressing produces concrete expanded targets;
- [x] direct/follower/public/unlisted/reply/Follow cases are covered;
- [x] producer/consumer semantic hardening is closed.

Evidence: ActivityPods PRs #16/#21; federation PRs #11/#14/#15.

## Phase 4 — Durable ActivityPods → sidecar handoff

**Status:** PASS  
**Slices:** `APDM-P4-A`, `APDM-P4-F`

Move from best-effort observation to explicit durable delivery-intent handoff. ActivityPods retries handoff; the sidecar acknowledges only after durable acceptance.

Exit gate:
- [x] crash-point tests prove no lost accepted intents;
- [x] retries are idempotent;
- [x] duplicate handoff converges without duplicate remote execution;
- [x] replay/idempotency horizon is bounded and later hardened without changing the authority split.

Evidence: ActivityPods PR #17 plus replay-horizon hardening; federation PRs #12/#13/#25.

## Phase 5 — Fedify remote-authority cutover

**Status:** PASS  
**Slices:** `APDM-P5-A`, `APDM-P5-F`

Enable production external mode only after follower expansion, durable handoff, signing, retry/DLQ, egress-security and compatibility gates are green.

Exit gate:
- [x] SemApps native `remotePost` count is zero in external mode;
- [x] Fedify/sidecar is the sole external ActivityPub HTTP executor in external mode;
- [x] ActivityPods keeps key custody/signing authority;
- [x] remote execution has DNS-aware SSRF/rebinding protection and redirects disabled;
- [x] native mode remains deterministic rollback;
- [x] interoperability gates pass.

Evidence: ActivityPods PR #26; federation PR #28 and paired cutover hardening.

## Phase 6 — Remove transitional duplicate routing

**Status:** PASS  
**Slices:** `APDM-P6-A`, `APDM-P6-F`

Retire raw-Activity recipient routing as an authority. Keep one routing authority and one remote executor while retaining observation/indexing behavior and rollback.

Exit gate:
- [x] external handoff authority is bound to one Delivery Plan intent;
- [x] ActivityPods no longer reconstructs remote routing from raw Activity fields in the transitional emitter;
- [x] native-mode indexing uses a targetless observation path that cannot create federation jobs;
- [x] stale duplicate routing code/operator guidance is removed.

Evidence: ActivityPods PR #27; federation PR #30.

## Phase 7 — Local fan-out low-risk waste removal

**Status:** PASS  
**Primary:** `APDM-P7-A`

Eliminate the duplicate local `auth.account.findByWebId` lookup by carrying already-resolved account/dataset context into local delivery without altering storage semantics.

Exit gate:
- [x] duplicate lookup is removed on the normal path;
- [x] legacy/direct localPost callers retain fallback behavior;
- [x] inbox contents, LDP/WebACL/Pod dataset boundaries and emitted semantics remain unchanged;
- [x] pinned SemApps patch fails closed on version/source drift.

Evidence: ActivityPods PR #28.

## Phase 8 — Nested Tier 1 instrumentation and real cost model

**Status:** PASS  
**Primary:** `APDM-P8-A`

Measure the real local hot path at 1, 10, 100, 200 and 1,000 local recipients.

Capture:
- nested Moleculer actions;
- Fuseki/SPARQL requests;
- WebACL and LDP work;
- elapsed time, CPU and heap;
- successful/failed local-recipient outcomes.

Exit gate:
- [x] canonical N=1/10/100/200/1000 real-runtime matrix completed;
- [x] detached localPost completion and partial failures are correlated correctly;
- [x] source-counted `6N + O(1)` model is reconciled with measured nested work;
- [x] historical ~8,000-operation estimate is retired in favor of measured evidence.

Closure evidence: ActivityPods PRs #29/#30; PR #30 merged as `e51e5cacd0696e558d7860920025279c9cad22ed`.

## Phase 9 — Bounded local concurrency and empirical default selection

**Status:** PASS  
**Primary:** `APDM-P9-A`

Replace strict serial recipient scheduling with a configurable bounded worker pool. Never allocate one promise per recipient.

Exit gate:
- [x] bounded primitive preserves deterministic partial-failure/result ordering;
- [x] real c1/c2/c4/c8 measurements use matched successful canonical samples;
- [x] selection is evidence-based rather than guessed;
- [x] smallest qualifying candidate is promoted with an explicit serial rollback;
- [x] existing c1-patched installations have a fail-closed upgrade path.

Closure evidence:
- primitive: ActivityPods PR #65, merge `8684c58ad1d494e60ffcfa15ab19ef1c67cce16c`;
- evidence: PR #66, merge `154b40873fec0886c4e2a25e67d6e644fe69ec4c`;
- canonical raw measurement run `31956939507`; hardened replay `31964215322`;
- c4 promotion: PR #68, merge `5d7f2ff0631402e143000af68c174f8c615a755a`.

## Phase 10 — Local metadata round-trip reduction

**Status:** IN PROGRESS  
**Primary:** `APDM-P10-A`

Phase 8 showed that the largest safe-looking metadata amplifier was repeated dataset-existence authority checking (about 16 `triplestore.dataset.exist` action attempts per recipient at N=1000), while actor/inbox resource reads already benefited from caching. The roadmap is therefore refined to optimize **measured metadata round trips first**, rather than forcing an assumed account/inbox batching implementation.

Current first slice:
- delivery-scoped positive reuse of `triplestore.dataset.exist` within the exact SemApps `localPost()` async lineage;
- false/error results are never memoized;
- dataset lifecycle mutations invalidate the scope and an epoch blocks stale in-flight positives;
- rollout is fail-closed and remains disabled by default;
- real correlated Fuseki `GET /$/datasets/{dataset}` traffic is the authoritative mechanism signal.

Exit gate:
- [x] implementation/hardening exists in ActivityPods PR #67;
- [x] branch is rebased on the Phase 9 c4 production baseline;
- [x] exact-head backend unit/smoke gate passes before measurement launch;
- [ ] matched OFF/ON real c4 measurements complete at N=1/10/100/200/1000 with at least three successful samples per arm;
- [ ] N=100/200/1000 each show >=50% reduction in real dataset-registry GETs and lower total Fuseki HTTP work;
- [ ] delivery correctness and LDP/WebACL/Pod semantics remain unchanged;
- [ ] CPU/heap/latency/resource comparability are reviewed before any production-default promotion;
- [ ] evidence-backed promotion decision (enable or remain disabled) is merged before Phase 10 is marked PASS.

Current evidence run: `31965449687`, launched from frozen ActivityPods head `1f512cfb192ab469b9684cb17a7e3af2756a3cdb`. Its result is not pre-declared here.

## Phase 11 — Batch-safe local persistence

**Status:** BLOCKED by Phase 10  
**Primary:** `APDM-P11-A`

Analyze and optimize `activitypub.collection.add`, `ldp.remote.store` and `activitypub.activity.attach` without bypassing Pod dataset isolation, WebACL, collection ordering, notifications or LDP invariants.

Exit gate:
- [ ] Phase 10 is PASS;
- [ ] persistence bottlenecks are measured on the post-Phase-10 baseline;
- [ ] semantic parity tests prove any optimized persistence path equivalent to current behavior.

## Phase 12 — Durable local fan-out and partial-failure recovery

**Status:** NOT STARTED / blocked by preceding phases  
**Primary:** `APDM-P12-A`

Add stable activity-recipient idempotency and recoverable per-recipient state so successful recipients are not replayed while transient failures can be retried.

## Phase 13 — Canonical bridge convergence

**Status:** NOT STARTED / blocked by preceding phases  
**Primary:** `APDM-P13-A`; integration checks in federation repo as needed.

Route cross-protocol canonical notifications through the common optimized local-delivery primitive instead of retaining an independent sequential actor-get/inbox-post loop.

## Phase 14 — Shared-inbox hardening

**Status:** NOT STARTED / blocked by preceding phases  
**Primary:** `APDM-P14-F`

Carry authoritative actor/inbox metadata from ActivityPods, prefer supplied `sharedInboxUrl`, retain remote discovery only as fallback, improve cache invalidation, and measure shared-inbox collapse/hit rates.

## Phase 15 — End-to-end load, fault and interoperability proof

**Status:** NOT STARTED / blocked by preceding phases  
**Slices:** `APDM-P15-A`, `APDM-P15-F`

Scenarios include local-heavy, remote-heavy, mixed, large direct addressing, sidecar outage, ActivityPods crash, Redis outage, Fuseki slowdown, 429/5xx, stale sharedInbox and partial local failure.

Exit gate:
- [ ] published p50/p95/p99, queue, memory, HTTP, Fuseki and duplicate-delivery baselines;
- [ ] correctness and recovery invariants pass.

## Phase 16 — Stabilization and migration cleanup

**Status:** NOT STARTED / blocked by preceding phases  
**Slices:** `APDM-P16-A`, `APDM-P16-F`

Remove obsolete native remote deployment dependencies and transitional parsing only after stabilization evidence, freeze the delivery contract, document rollback/version requirements, and update architecture/operator guidance.
