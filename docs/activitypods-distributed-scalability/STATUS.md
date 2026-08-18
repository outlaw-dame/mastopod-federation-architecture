# ADSP Status

Last updated: 2026-08-18

This is the live cross-repository evidence ledger for the ActivityPods Distributed Scalability Program. `PHASES.md` defines phase ownership and exit gates. `BENCHMARK-CONTRACT.md` defines evidence validity and promotion rules. Detailed Phase-0 evidence is in `P0-SOURCE-BASELINE.md`, `P0-TIER1-RUNTIME-EVIDENCE.md`, `P0-REMOTE-RUNTIME-EVIDENCE.md`, and `P0-PROMOTION-THRESHOLDS.md`.

## Program checklist

- [x] ADSP-P0 — baseline, authority and benchmark contract — **COMPLETE: incumbent variance measured and numerical Phase-2/3 thresholds locked before NATS evidence**
- [x] ADSP-P1 — safe distributable Moleculer fabric — **COMPLETE: all seven exit gates closed with real Redis-transporter, production-cell locality, launcher-isolation and node-loss evidence**
- [ ] ADSP-P2 — horizontal ActivityPods / Redis transporter — **NEXT / unblocked by P1**
- [ ] ADSP-P3 — NATS Core transporter comparison — blocked by P2
- [ ] ADSP-P4 — qualified extension/reuse of Redis Streams — conditional
- [ ] ADSP-P5 — JetStream evaluation — conditional / entry gate closed by default
- [ ] ADSP-P6 — deployment profiles and stabilization — blocked by selected architecture

## Frozen source baseline

Setup heads remain:

- ActivityPods: `3fad15838ec098d8d32c0f36cd8c75cbb66a46a8`
- federation architecture: `e20c32fc5d4c9b9157de3063345e050ea3ec5007`

Confirmed baseline constraints:

- ActivityPods runs the broad backend service tree as one colocated Moleculer service cell.
- Moleculer uses literal `nodeID: 'pod-provider'`, no explicit namespace, Redis-transporter selection, and serializer behavior coupled to that transporter setting.
- Redis cache, transporter, queue and OIDC-state responsibilities are distinct.
- the sidecar already uses Redis Streams for durable inbound, outbound, outbox-intent and origin-reconcile workloads with consumer groups, pending reclaim and bounded DLQ handling.
- ActivityPods owns authoritative ActivityPub planning/local semantics; the sidecar owns external HTTP execution in external mode.
- existing Redis/Bull/Redis-Streams durability remains incumbent during later transporter comparison.

The frozen P0 source heads are retained as historical baseline provenance. Later merged hardening does not rewrite that baseline; Phase-2 evidence must record its own exact current heads and configuration.

## Phase-0 runtime evidence

### Fixture A — Tier-1 local fanout: COMPLETE

Run `32070748744` executed ActivityPods `306e718b3d29a78f032d0545a0c66c22d533bb1f` and produced 25/25 successful measured samples across `N=1,10,100,200,1000`, five samples per point after warmup.

The Phase-10 dataset-existence memo remained OFF and the federation sidecar was explicitly excluded. N=1 elapsed time was very noisy (~170% CV); N=10–1000 elapsed CV was roughly 1–4%. Exact CPU/action/Fuseki/Redis/resource evidence and artifact provenance are recorded in `P0-TIER1-RUNTIME-EVIDENCE.md`.

For threshold derivation, stable `N=10–1000` points had worst observed per-case CV of:

- elapsed time: **3.85%**;
- completed-work CPU: **8.50%**;
- ending RSS: **15.55%**.

`N=1` remains correctness/smoke evidence and is excluded from precise latency promotion decisions.

### Fixture B — mixed/remote federation: COMPLETE for frozen correctness scope

Whole-system run `32086514942` passed all three deterministic scenarios using:

- ActivityPods candidate `2d18680ce399682ac4e85a2bd777aaf8f631b81a`;
- federation candidate `337e62999ef6fa4e14e126987dec5be67c8e49c6`.

Proven path:

`activitypub.outbox.post → authoritative Delivery Plan → one suppressed native remotePost → durable ActivityPods handoff → sidecar 202 → Redis Streams outbox-intent → RedPanda event log → outbound job → ActivityPods signing → controlled remote HTTP → completion/retry/DLQ`.

Outcomes:

- success: one HTTP request → `202`;
- transient: `503` → bounded retry → `503` → bounded retry → `202`, three requests total;
- permanent: one HTTP request → `410` → permanent-failure DLQ;
- every scenario had a positive RedPanda publication marker and zero reconciliation errors.

The artifact retains ActivityPods/sidecar process snapshots, Docker stats, Redis command/memory snapshots, RedPanda topic descriptions, service logs and strict controlled-target observations. With one deterministic run per scenario this is correctness/failure evidence, not a remote latency-distribution claim.

Exact evidence is in `P0-REMOTE-RUNTIME-EVIDENCE.md`.

Implementation closures:

- ActivityPods PR #83 merged as `7a727f52ba783added771f87693afbcb4fd8c536`.
- federation PR #80 merged as `2cd1c097456756c8c28d349dfc800d36cfd6fce6`.
- no submitted reviews or review threads were outstanding at merge time.

## RedPanda AP stream semantics — VERIFIED

Independent real-broker run `32086514958` used the production producer and consumed the actual RedPanda topics afterward. It proved exactly:

- `ap.stream1.local-public.v1` = local public ActivityPub aggregate for this Pod provider;
- `ap.stream2.remote-public.v1` = remote public ActivityPub aggregate from accepted remote sources, including relay/service ingress where applicable;
- `ap.firehose.v1` = Stream1 + Stream2, with each proof event observed exactly once;
- `ap.tombstones.v1` remains separate;
- `canonical.v1` remains a separate protocol-neutral intent log.

The proof detected no Stream1/Stream2 cross-contamination and no tombstone leakage into the AP firehose.

## P0 numerical thresholds — LOCKED

The threshold contract was frozen from the incumbent evidence above **without generating or inspecting a NATS-Core benchmark result**.

Key locked gates are:

- no-new-runtime materiality: **≥10%** improvement in a primary whole-system metric;
- added-runtime materiality: **≥20%** primary improvement plus **≥10%** secondary improvement, or ≥20% higher completed-work throughput at the same total resource ceiling;
- p95 latency regression ceiling: **+10%**;
- p99/tail latency regression ceiling: **+15%**;
- whole-system CPU regression ceiling: **+15%**;
- whole-system and ActivityPods median RSS regression ceiling: **+20%**;
- correctness: **0** unexplained lost/duplicate authoritative outcomes or semantic/privacy drift;
- horizontal scale: `1→2` and `2→4` each require **≥1.50x** throughput or **≥20%** p95 reduction when the smaller arm is saturated;
- recovery after dependency reachability returns: **≤30 seconds**, with Phase-3 recovery p95 also ≤`1.25x` the matched Redis comparator;
- new-runtime advantages must reproduce in a second matched evidence set.

Full derivation, sample policy, operational-cost penalty and immutability rules are in `P0-PROMOTION-THRESHOLDS.md` and `BENCHMARK-CONTRACT.md`.

## P0 gate reconciliation

`PHASES.md` assigns multi-node node IDs, namespace isolation, transport-independent serialization, RDF semantic parity across remote calls, explicit locality groups, and node join/leave/rejoin behavior to **Phase 1**. They are not unfinished Phase-0 requirements.

Phase 0 has:

1. verified source/runtime topology in both repositories;
2. classified Redis responsibilities;
3. reproducible local and remote runtime evidence;
4. measured incumbent variance;
5. numerical Phase-2/3 comparison thresholds locked before NATS evidence;
6. confirmed APDM/Tier-1/Tier-2 authority boundaries;
7. exact baseline commits, workflow runs and artifact digests recorded.

**ADSP-P0 is complete.**

## Phase-1 safe distributable Moleculer fabric — COMPLETE

ActivityPods Phase-1 work was deliberately split into narrow evidence slices rather than treating a configurable Redis transporter as proof that the application was safely distributable.

### P1 foundation — IDs, namespace, serializer, remote semantics and registry convergence

ActivityPods PR #87 merged as `bf81df6518b1391952429223349f49de81ba5811`.

Exact candidate head `c829f76652769fe5a6faffdc5aad600024c49a17` passed:

- Backend Checks run `32138708599`;
- ADSP P1 Moleculer Fabric run `32138708719`.

The merged fabric:

- preserves native single-process defaults as `nodeID=pod-provider`, no required namespace/transporter, and the full production Pod/SemApps service cell;
- requires explicit unique node ID, namespace and incumbent Redis transporter URL in distributed mode;
- fails closed on invalid distributed settings and unknown service groups;
- keeps `RdfJSONSerializer` selected independently of transporter presence;
- proves two distinct brokers coexist in one namespace without node-ID collision;
- proves an isolated namespace cannot discover the probe service;
- proves genuine Redis-transported RDF/JSON-LD payload and error parity;
- proves endpoint removal after node leave and clean replacement-node registry convergence;
- adds bounded local/remote action telemetry.

### P1 production locality

ActivityPods PR #88 merged as `89ebefa21865cae55848f12920598cfd1af6af29`.

Corrected exact-head evidence on `376b7d63b339e99f70143fc3c09a805b2d337929` passed:

- ADSP P1 Moleculer Fabric run `32140054730`;
- Backend Checks run `32140054620`;
- ADSP P1 Pod Cell Locality run `32140054623`.

The duplicate-cell proof exposed two endpoints for the same actions and recorded 100 local outer+nested executions per cell with zero remote nested calls. The real ActivityPods/Fuseki/Redis Tier-1 proof then provisioned ten fully bootstrapped local actors and, after a genuine measured Tier-1 sample, recorded **7,875 local executions and 0 remote Moleculer calls**, including `activitypub.outbox.post` activity in the telemetry snapshot.

This closes the requirement that tightly coupled Pod/SemApps work remains local by default even when a transporter exists.

### P1 independently startable service groups

ActivityPods PR #89 merged as `921ff5af5cfeb8a6af99b69d59b987202fc579f6`.

Exact candidate head `f1fbe93e9cd39831d877847dc974affb6754b28c` passed:

- Backend Checks run `32141314012`;
- ADSP P1 Moleculer Fabric run `32141314010`;
- ADSP P1 Pod Cell Locality run `32141313980`.

The real launcher proof found and fixed two defects that static config tests had missed: a Node-22-incompatible Moleculer runner subpath resolution and production middleware leaking into the isolated probe group. After the fixes, the launched `p1-probe` process reported exactly `$node`, `adsp.p1.localityProbe`, and `adsp.p1.rdfProbe`, with **zero production services loaded**. The production Pod-cell locality lane re-passed on the same head, proving the middleware scoping fix did not remove the production stack.

### P1 node-loss/rejoin authority semantics

ActivityPods PR #90 merged as `976f3d774fbe83f801f3765626a149227816f49b`.

Exact candidate head `ee4ff697d598dd8812046f815f66913f2a978ecd` passed:

- Backend Checks run `32145499094`;
- ADSP P1 Moleculer Fabric run `32145499023`.

The failure proof exercised the ambiguous commit window on the real Redis Moleculer transporter:

1. the serving worker durably wrote and `fsync`'d one authoritative test mutation;
2. a second eligible endpoint joined;
3. the serving process was killed with `SIGKILL` before returning its response;
4. the caller received `503 REQUEST_REJECTED`, not false success;
5. the committed token remained exactly once and was not replayed to the survivor;
6. the killed node ID rejoined and a new mutation committed exactly once on that rejoined node.

Observed final evidence: original durable mutation count `1`, silent replay `false`, rejoin mutation count `1`, final mutation count `2`.

This proves the **fabric** does not silently replay already-committed authoritative work across an ambiguous node-loss window. It does not make caller retries automatically idempotent and does not replace the Phase-2 requirement to test real ActivityPub/Pod mutations under horizontal node loss.

### P1 exit-gate reconciliation

All seven Phase-1 exit gates are now closed:

1. multiple brokers coexist with unique node IDs;
2. namespace isolation prevents cross-environment discovery;
3. serializer behavior is transport-independent and genuine remote RDF/JSON-LD semantics pass;
4. service groups start independently without loading the full production schema tree;
5. real Pod/SemApps-cell locality remains local by default;
6. node loss/rejoin rejects ambiguous requests without silently replaying committed authority;
7. the native single-process full-cell deployment remains the default supported low-resource profile.

**ADSP-P1 is complete. ADSP-P2 is now the next authorized phase.** Phase 3 NATS testing remains blocked until the Phase-2 horizontal Redis comparator is complete. JetStream remains unauthorized.

## Phase-2 starting boundary

Phase 2 must now build and measure the first real horizontal ActivityPods comparator using the **incumbent Redis Moleculer transporter** and the P1 service/locality contracts. It must not jump directly to NATS.

The Phase-2 evidence must record exact current heads and keep sidecar/federation settings matched across replica arms. In particular, the feature-gated Redis Stream Brotli writer merged in federation PR #90 remains **off by default**; Phase-2 comparisons must pin that setting consistently rather than changing sidecar queue encoding between replica-count arms.

Phase 2 still owes all of its own gates: matched one/multi-node correctness, throughput and p50/p95/p99, CPU/RSS/Redis/Fuseki evidence, 2- and 4-replica scale-out efficiency where the environment permits, bounded node-loss recovery under load, and zero loss/duplication of accepted ActivityPub delivery intent or authoritative Pod mutation.

## Decision ledger

| Decision | State | Reason |
|---|---|---|
| Redis transporter for horizontal ActivityPods | Phase-2 incumbent comparator / NEXT | existing infrastructure; P1 safety gates are closed, so Redis horizontal evidence is now authorized |
| NATS Core | unselected candidate | test only after the P2 Redis horizontal baseline exists and only against the locked thresholds |
| Existing sidecar Redis Streams | incumbent / preserved | already provides durable federation work queues |
| RedPanda AP public streams | incumbent / verified | Stream1 local + Stream2 remote; AP firehose is their union |
| Redis Stream Brotli compression | merged capability, writer off by default | evidence-backed queue optimization; must be pinned consistently during transporter/replica comparisons |
| Additional Redis Streams workloads | unselected workload-specific candidate | extend/reuse only after workload evidence qualifies it |
| JetStream | not authorized | Phase-5 entry gate requires a reproduced material Redis limitation |

## Relationship to APDM

At the frozen ActivityPods baseline, APDM Phase 10 is already closed. ADSP consumes APDM evidence but does not advance APDM gates, and APDM does not advance ADSP gates by implication.
