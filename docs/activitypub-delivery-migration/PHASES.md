# APDM Phases

## Phase 0 — Cross-repo baseline and authority

**Slices:** `APDM-P0-A`, `APDM-P0-F`

Goals:
- freeze the verified SemApps 1.1.4 delivery call graph;
- document repository ownership and migration boundaries;
- establish shared phase identifiers, invariants, status tracking and acceptance gates;
- make no runtime delivery behavior changes.

Exit gate:
- both repos contain linked Phase 0 documentation;
- no disagreement about current local/remote behavior or ownership;
- future PRs use APDM identifiers.

## Phase 1 — Delivery Plan v1 contract

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
- producer and consumer fixtures pass byte/semantic compatibility tests in both repos.

## Phase 2 — Pre-`remotePost` delivery-strategy seam

**Primary:** `APDM-P2-A`

Introduce a clean ActivityPods/SemApps integration seam before native `remotePost` job creation. Support `native` and `external` remote delivery modes; default remains `native` during migration.

Exit gate:
- in `external` test mode, zero SemApps `remotePost` jobs are created;
- local delivery behavior remains unchanged;
- native rollback mode remains tested.

## Phase 3 — Authoritative expanded recipient planning

**Primary:** `APDM-P3-A`; consumer fixtures in `APDM-P3-F`

Reuse SemApps `getRecipients` output rather than making the sidecar re-parse raw `to`/`cc`/`bto`/`bcc` fields. Preserve local/remote classification and resolved metadata in the Delivery Plan.

Exit gate:
- a post addressed only to the actor's `/followers` collection produces concrete remote targets for remote followers;
- direct, follower, public/unlisted, reply and Follow addressing cases are covered.

## Phase 4 — Durable ActivityPods → sidecar handoff

**Slices:** `APDM-P4-A`, `APDM-P4-F`

Move from best-effort event observation to an explicit durable delivery-intent handoff. ActivityPods retries handoff; sidecar acknowledges only after durable acceptance.

Exit gate:
- crash-point tests prove no lost intents;
- retries are idempotent;
- duplicate handoff does not cause duplicate remote execution.

## Phase 5 — Fedify remote-authority cutover

**Slices:** `APDM-P5-A`, `APDM-P5-F`

Enable `external` mode only after follower expansion, durable handoff, signing, retry/DLQ and compatibility gates are green.

Exit gate:
- SemApps native `remotePost` count is zero in external mode;
- Fedify is the sole external ActivityPub HTTP executor;
- public, unlisted, followers-only, direct mention, reply, Follow/Accept/Undo, Announce, Like, Update and Delete flows pass interoperability tests.

## Phase 6 — Remove transitional duplicate routing

**Slices:** `APDM-P6-A`, `APDM-P6-F`

Retire raw-activity recipient routing as an authority. Keep one routing authority and one remote executor. Remove obsolete compatibility code only after Phase 5 proves rollback and parity.

## Phase 7 — Local fan-out low-risk waste removal

**Primary:** `APDM-P7-A`

Eliminate the duplicate `auth.account.findByWebId` lookup by carrying resolved account/dataset data into local delivery. Do not alter storage semantics yet.

Exit gate:
- behavior parity tests pass;
- visible recipient-specific calls decrease without changing inbox contents or emitted semantics.

## Phase 8 — Nested Tier 1 instrumentation

**Primary:** `APDM-P8-A`

Measure the real local hot path at 1, 10, 100, 200 and 1,000 local recipients.

Capture:
- top-level Moleculer actions;
- nested Moleculer calls;
- Fuseki/SPARQL requests and updates;
- WebACL evaluations;
- LDP calls;
- elapsed time, CPU and heap.

Exit gate:
- source-counted `6N + O(1)` top-level model is reconciled with measured nested work;
- historical ~8,000-operation estimate is either validated, corrected or retired.

## Phase 9 — Bounded local concurrency

**Primary:** `APDM-P9-A`

Replace strict serial recipient processing with configurable bounded concurrency. Never use unbounded `Promise.all` for local Pod delivery.

Exit gate:
- meaningful wall-clock improvement without Fuseki/heap overload;
- partial-failure behavior remains deterministic.

## Phase 10 — Batch metadata resolution

**Primary:** `APDM-P10-A`

Introduce coarse-grained resolution of local account, dataset and inbox metadata, using caching/batch queries where safe.

Exit gate:
- metadata resolution datastore round trips scale by batch rather than recipient where possible.

## Phase 11 — Batch-safe local persistence

**Primary:** `APDM-P11-A`

Analyze and optimize `activitypub.collection.add`, `ldp.remote.store` and `activitypub.activity.attach` without bypassing Pod dataset isolation, WebACL, collection ordering, notifications or LDP invariants.

Exit gate:
- semantic parity tests prove optimized persistence is equivalent to the current path.

## Phase 12 — Durable local fan-out and partial-failure recovery

**Primary:** `APDM-P12-A`

Add stable activity-recipient idempotency and recoverable per-recipient state so successful recipients are not replayed while transient failures can be retried.

## Phase 13 — Canonical bridge convergence

**Primary:** `APDM-P13-A`; integration checks in federation repo as needed.

Route the cross-protocol canonical-notification bridge through the same optimized local delivery primitive instead of maintaining an independent sequential actor-get/inbox-post loop.

## Phase 14 — Shared-inbox hardening

**Primary:** `APDM-P14-F`

Carry authoritative actor/inbox metadata from ActivityPods, prefer supplied `sharedInboxUrl`, retain remote discovery as fallback, improve cache invalidation, and measure collapse/hit rates.

## Phase 15 — End-to-end load, fault and interoperability proof

**Slices:** `APDM-P15-A`, `APDM-P15-F`

Scenarios include local-heavy, remote-heavy, mixed, large direct addressing, sidecar outage, ActivityPods crash, Redis outage, Fuseki slowdown, 429/5xx, stale sharedInbox and partial local failure.

Exit gate:
- published p50/p95/p99, queue, memory, HTTP, Fuseki and duplicate-delivery baselines;
- correctness and recovery invariants pass.

## Phase 16 — Stabilization and migration cleanup

**Slices:** `APDM-P16-A`, `APDM-P16-F`

Remove obsolete native remote deployment dependencies and transitional parsing, freeze the delivery contract, document rollback/version requirements, and update the V6 architecture diagrams and operator guidance.
