# ADSP Current Cross-Repository Handoff — 2026-08-20

This document is the durable continuation point for the current SemApps / ActivityPods + Fedify ADSP work. It exists so a new ChatGPT/Codex session can resume without reconstructing a very large conversation.

## Standing project directives

These are persistent operating rules, not one-turn preferences.

1. **Do not silently replace the primary workstream with side work.** The user may ask for additional investigations, fixes, research, or implementation while a phase or primary task is active. Treat those as bounded side work unless the user explicitly changes priorities. After the side work is completed, return to the primary work from the exact interruption point.
2. Preserve exact repo/branch/head awareness. Never claim work is complete, merged, green, or proven unless the relevant repository state and evidence were actually verified.
3. Avoid drift and duplication. Preserve core ActivityPods/SemApps compatibility and the existing authority boundaries.
4. Prefer accuracy, security/privacy, fail-closed behavior, exact-head CI, independent artifact inspection, and deterministic/replayable evidence over superficial passing checks.
5. Never weaken frozen empirical gates or reinterpret prior failed evidence to make a phase pass.
6. Keep W3 closed unless a new correctness regression genuinely invalidates its merged proof; do not rerun or reinterpret it casually.
7. NATS Core / JetStream remain blocked unless the frozen ADSP decision contract is satisfied. Do not introduce them merely because Redis work is difficult.

## Primary repositories

- ActivityPods fork: `outlaw-dame/activity-pods`
- Federation architecture / Fedify sidecar: `outlaw-dame/mastopod-federation-architecture`

Architecture principle:

- ActivityPods/SemApps remains authoritative for local application state and local work.
- Fedify sidecar remains authoritative for the remote federation path.
- Redis already exists in the architecture.
- Do not create a second outbound federation authority path.

## Frozen ADSP Phase-2 decision contract

Unit of success: **correct completed application work at known resource cost**.

Correctness gates:

- 0 unexplained lost authoritative outcomes.
- 0 unexplained duplicate authoritative outcomes.
- 0 privacy/addressing drift.
- 0 partial success accepted as success.

Scale gates:

- 1→2 replicas must provide either at least **1.50x successful throughput** or at least **20% p95 latency reduction** when the lower topology is demonstrably saturated.
- 2→4 has the same gate.

Failure gate:

- transient failure must recover automatically;
- dependency reachability and registry convergence must recover within **30 seconds after the dependency becomes reachable**;
- the threshold cannot be relaxed after seeing the results.

Phase-3 gating:

- NATS Core is tested only if the Redis P2 comparator is promotable and NATS can materially beat it.
- JetStream is considered only later for a real durable workload with a reproduced Redis limitation.

## Canonical Phase-2 evidence already closed

### W1

Canonical W1 replacement run: `32256193005`

Exact merged federation head: `54ca8024d3c6f374988cca5b32eb6281f57c1aa2`

Result:

- N=10 passes the scaling gates strongly.
- N=100 fails both the 1→2 and 2→4 scaling gates; 2→4 is essentially flat.

This **mixed result is frozen**. Even if the node-loss correctness gate passes, Redis P2 is not promotable under the frozen contract because the canonical N=100 scaling evidence failed. NATS Core and JetStream therefore remain blocked.

### W3

W3 is closed and must not be redone as ordinary continuation work.

Important ActivityPods correction:

- ActivityPods PR #97 merged as `d0b2fce2cfcfd5d319d708005dd960790a08f894`.
- It added the missing P1/P2-standard `RdfJSONSerializer` plus `registry.preferLocal` for the W3 broker.
- Any older W3 execution against the previous `b09c...` pin is invalidated.

Federation W3 PR #93 has already been merged.

## Current primary work — ActivityPods PR #106

Repository: `outlaw-dame/activity-pods`

PR: **#106 — ADSP P2: prove node-loss recovery under real load**

Branch: `agent/adsp-p2-node-loss-under-load`

PR must remain **draft** until exact-head Backend Checks and the dedicated live node-loss lane pass and the uploaded evidence is independently inspected.

### Purpose

Close the remaining ActivityPods-side P2 node-loss correctness/recovery gate using:

- the real four-cell distributed ActivityPods/SemApps topology;
- Redis transporter;
- `RdfJSONSerializer`;
- `registry.preferLocal`;
- real `activitypub.outbox.post` work;
- a deterministic ambiguous-commit SIGKILL boundary;
- authoritative Fuseki persistence audit;
- Redis command-health audit;
- exact-head evidence.

No benchmark-only HTTP ingress, no second delivery authority, no NATS, no JetStream.

## Node-loss evidence design

Four real pod-cell replicas participate in the same Redis namespace.

The production distributed heartbeat defaults were tightened because Moleculer 0.14.34's default 10s heartbeat / 30s timeout plus stale-node sweep could approach ~60s. Distributed pod cells now use a 5s heartbeat interval / 10s timeout with an enforced maximum timeout of 12s. Single mode remains unchanged. The external load-driver broker uses matching heartbeat parity.

### Deterministic ambiguous commit boundary

A narrowly scoped evidence middleware is enabled only for the dedicated lane and only for the selected victim request on replica 4.

For that request:

1. real root `activitypub.outbox.post` completes;
2. evidence records `boundary: root-action-complete-response-held`;
3. the response is withheld;
4. the workflow sends SIGKILL to replica 4;
5. caller must observe rejected/unknown exactly once;
6. the harness never retries it.

Eight concurrent N=10 roots are used for the fault burst.

After the kill the lane requires:

- 4→3 endpoint convergence ≤30s;
- accepted survivor work across r1/r2/r3;
- victim restart;
- 3→4 convergence ≤30s;
- accepted post-rejoin work across r1/r2/r3/r4.

The 30-second bound applies to fabric convergence, not to application completion latency.

### Authoritative persistence audit

Each synthetic ActivityStreams object includes its unique request ID in content. The sender's authoritative Fuseki dataset is queried afterwards.

Cardinality contract:

- caller-accepted request → exactly 1 persisted resource;
- selected caller-rejected ambiguous-commit request → exactly 1 persisted resource;
- other caller-rejected fault requests → 0 or 1;
- any count >1 → hard failure.

### Redis audit

Redis command statistics are reset only **after** startup/provisioning and immediately before the actual fault workload, so normal EVALSHA/NOSCRIPT startup misses are excluded.

Workload interval requires:

- `failed_calls = 0`
- `rejected_calls = 0`

## Restart / ontology correctness investigation

Earlier live attempts repeatedly failed after victim restart with:

`Could not expand all types (Note). Is an ontology missing or not registered yet on the local context ?`

The original semantic probe used `Note` as a canary. This was not a Note-specific business rule.

A decisive artifact showed:

- replicas 1–3 had 21 local ontologies and successfully expanded ActivityStreams types;
- restarted replica 4 had only 14 ontologies;
- missing prefixes were exactly: `acl`, `as`, `cred`, `foaf`, `ldp`, `schema`, `sec`.

So the actual defect was **local ontology bootstrap state loss after restart**, especially the missing ActivityStreams (`as`) ontology.

Upstream SemApps ontology service at pinned upstream commit `751d53df941ef3f5f023bb42243038f355497181` resets broker-local state in `started()` with `this.ontologies = {}` before `registerAll()`.

Because Moleculer service dependencies can be satisfied remotely in distributed mode, another local service can start and call `ontologies.register` before the local ontology baseline has finished rebuilding. A per-ActivityPub fix would therefore be the wrong abstraction.

## Generic local ontology registration barrier

ActivityPods now has:

`pod-provider/backend/middlewares/adsp-local-ontology-registration.js`

Distributed pod-cell mode only.

It intercepts only `ontologies.register`, waits for the local ontology service baseline to exist, then invokes the **local** `ontologies.register` action directly. Explicit remote `nodeID` routing is removed for this broker-local mutation. Other options/meta are retained. Timeout is fail-closed.

A broader SemApps source audit found startup registration sites across ActivityPub, LDP, WebACL, WebID/Solid, VC/keys, notifications, void, inference, etc. using `broker.call('ontologies.register', ...)`; no equivalent `ctx.call('ontologies.register', ...)` startup registration path was found. This validates the generic broker-call boundary instead of an ActivityPub-only `as/sec` patch.

### Important lifecycle correction

A live provisioning artifact exposed a bug in the first implementation: the Moleculer middleware `call(next)` hook incorrectly treated `this` as the broker and crashed at `broker.getLocalService`.

The fix captures the broker through the middleware lifecycle `created(broker)` hook and uses that captured broker inside `call(next)`.

Tests were rewritten so they no longer cheat by manually binding `this` to a fake broker; they now exercise the lifecycle contract and fail closed if the broker was never initialized.

## JSON-LD / LDP distributed locality safeguards

Pinned patchers remain in place while the node-loss proof is open:

- `patch-semapps-jsonld-distributed-context-cache.js`
- `patch-semapps-ontologies-distributed-cache.js`
- `patch-semapps-jsonld-distributed-locality.js`
- `patch-semapps-ldp-distributed-semantic-locality.js`
- `patch-semapps-ldp-local-registry-bootstrap.js`

The production-image preflight discovered that some patchers were first-pass-safe but not truly second-pass-idempotent after `yarn install` had already patched the production image.

JSON-LD and LDP locality patchers were hardened to recognize a complete existing distributed rewrite while still failing closed on partial/structural drift. Markerless revalidation tests were added.

A later exact-head production image successfully passed the full second-pass module verification, proving this preflight problem is resolved.

## ActivityStreams semantic coverage — no longer Note-only

The restart semantic probe was broadened from a single `Note` canary to the ActivityStreams classes present in the W3C default `activitystreams.jsonld` context.

Coverage includes, among others:

- foundational: `Object`, `Link`, `Activity`, `IntransitiveActivity`, `Relationship`;
- collections: `Collection`, `OrderedCollection`, `CollectionPage`, `OrderedCollectionPage`;
- actors: `Person`, `Application`, `Group`, `Organization`, `Service`;
- content/object types: **`Article`**, `Audio`, `Document`, `Event`, `Image`, **`Note`**, `Page`, `Place`, `Profile`, `Question`, `Tombstone`, `Video`;
- activities: `Accept`, `Add`, `Announce`, `Arrive`, `Block`, `Create`, `Delete`, `Dislike`, `Flag`, `Follow`, `Ignore`, `Invite`, `Join`, `Leave`, `Like`, `Listen`, `Move`, `Offer`, `Read`, `Reject`, `Remove`, `TentativeAccept`, `TentativeReject`, `Travel`, `Undo`, `Update`, `View`;
- `Mention` and the relationship helper classes present in the default context.

For every pod cell, especially restarted r4, the probe requires:

- local ontology registry contains ActivityStreams (`as`);
- local/current JSON-LD context includes the ActivityStreams namespace;
- cached external ActivityStreams document is coherent;
- `jsonld.parser.expandTypes` resolves every required class to the exact `https://www.w3.org/ns/activitystreams#<Type>` IRI;
- explicit `Article` and `Note` assertions are retained as high-value regression cases.

`Public` is not treated as a class-expansion test because in the W3C context it is a special IRI term rather than an ActivityStreams object/activity class.

## Workflow cleanup hardening

A superseded run exposed another failure mode: an `if: always()` semantic-probe step could launch even if canonical provisioning had never created a topology, leaving Redis/Moleculer connection handles alive during cleanup.

The workflow now checks for the canonical provisioning artifact (`actors.json`) before launching the semantic probe. If provisioning never completed, the probe is skipped. After a genuine fault-stage failure, it still runs because provisioning evidence exists.

The semantic probe itself also has bounded broker start/stop helpers, but the workflow guard is the primary protection against a no-topology launch.

## Most recent known execution state at handoff creation

At the time this handoff was written, the ActivityPods PR #106 branch had advanced through lifecycle-fix commits and a fresh exact-head CI cycle had been started.

The most recent candidate head known immediately before this handoff was:

`29d2009d783b293ffafa342cf85b943bcab9c019`

Fresh node-loss run associated with that head:

`32351522312`

At the last observation before writing this handoff:

- production backend image build: in progress / subsequently expected to be rechecked;
- the prior exact-head run on `cc1223a8...` had already proven production-image preflight success but failed canonical provisioning because of the middleware lifecycle bug described above;
- that prior run correctly skipped the no-topology semantic probe and uploaded diagnostics;
- PR #106 remained draft and unmerged.

**Do not assume `29d2009d...` is still the current head in a future session. First re-fetch PR #106 and supersede all evidence whose `head_sha` does not equal the actual PR head.**

## Exact acceptance checklist for PR #106

Before marking ready or merging:

1. Re-fetch PR #106 and confirm exact head.
2. Require exact-head Backend Checks success.
3. Require exact-head `ADSP P2 Node Loss Under Load` success.
4. Download the exact run artifact independently.
5. Verify `environment.json` source/checkout SHA equals exact PR head and `exactHeadCheckout: true`.
6. Verify selected victim root entry appears exactly once at `root-action-complete-response-held` and was recorded before SIGKILL.
7. Verify caller saw selected request rejected/unknown exactly once and it was never retried.
8. Verify selected rejected request persisted exactly once.
9. Verify every accepted request persisted exactly once; no request persisted more than once.
10. Verify 4→3 and 3→4 registry convergence are each ≤30s.
11. Verify survivor accepted work covers r1/r2/r3.
12. Verify post-rejoin accepted work covers r1/r2/r3/r4.
13. Verify no duplicate completed traces / duplicate authoritative outcomes.
14. Verify Redis workload interval has zero failed/rejected calls.
15. Verify semantic probe passes all four nodes.
16. Specifically verify restarted r4 has the complete local ontology set expected of the other replicas, includes `as`, and expands **Article, Note, and the full required ActivityStreams class set** correctly.
17. Recheck PR reviews/comments and all required exact-head CI immediately before merge.
18. Keep PR draft until all evidence above is independently inspected.

## After PR #106 closes

Update/reconcile the federation architecture status with the node-loss result.

Even if node-loss passes:

- preserve the canonical W1 mixed result;
- Redis P2 remains **non-promotable** because N=100 failed the frozen scaling gates;
- do not begin NATS/JetStream Phase-3 benchmarking.

Then return to the next legitimate primary ADSP work item identified by the existing roadmap/status rather than drifting into an unrelated optimization.

## Separate but remembered side thread: Stream1 / Redpanda

Earlier, the user asked whether ActivityPods actually has a server-local aggregate of local **public** activities that Redpanda can connect to as Stream1.

Do not assume existing per-user outboxes, local delivery fanout, Redpanda logs, or custom-feed machinery prove that aggregate exists.

If returning to this thread, inspect current repos and explicitly distinguish:

- per-user outboxes;
- local fanout;
- server-local public activity aggregate;
- Redpanda event log;
- custom-feed/recommendation pipeline.

Any Stream1 aggregate must be public-only, exact-local-authority, ACL/privacy fail-closed, idempotent/replayable, have stable IDs/provenance, and must not become a second federation route.
