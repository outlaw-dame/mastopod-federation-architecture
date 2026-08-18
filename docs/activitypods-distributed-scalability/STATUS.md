# ADSP Status

Last updated: 2026-08-18

This is the live cross-repository evidence ledger for the ActivityPods Distributed Scalability Program. `PHASES.md` defines phase ownership and exit gates. `BENCHMARK-CONTRACT.md` defines evidence validity and promotion rules. Detailed Phase-0 evidence is in `P0-SOURCE-BASELINE.md`, `P0-TIER1-RUNTIME-EVIDENCE.md`, `P0-REMOTE-RUNTIME-EVIDENCE.md`, and `P0-PROMOTION-THRESHOLDS.md`.

## Program checklist

- [x] ADSP-P0 — baseline, authority and benchmark contract — **COMPLETE: incumbent variance measured and numerical Phase-2/3 thresholds locked before NATS evidence**
- [ ] ADSP-P1 — safe distributable Moleculer fabric — **NEXT; now unblocked by P0**
- [ ] ADSP-P2 — horizontal ActivityPods / Redis transporter — blocked by P1
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

Phase 0 now has:

1. verified source/runtime topology in both repositories;
2. classified Redis responsibilities;
3. reproducible local and remote runtime evidence;
4. measured incumbent variance;
5. numerical Phase-2/3 comparison thresholds locked before NATS evidence;
6. confirmed APDM/Tier-1/Tier-2 authority boundaries;
7. exact baseline commits, workflow runs and artifact digests recorded.

**ADSP-P0 is complete. ADSP-P1 is now the next authorized phase.** Phase 3 NATS testing remains blocked until P1 and the Phase-2 Redis horizontal comparator are complete. JetStream remains unauthorized.

## Decision ledger

| Decision | State | Reason |
|---|---|---|
| Redis transporter for horizontal ActivityPods | comparator only | existing infrastructure; becomes frozen Phase-3 comparator only after P1/P2 gates pass |
| NATS Core | unselected candidate | test only after the P2 Redis horizontal baseline exists and only against the locked thresholds |
| Existing sidecar Redis Streams | incumbent / preserved | already provides durable federation work queues |
| RedPanda AP public streams | incumbent / verified | Stream1 local + Stream2 remote; AP firehose is their union |
| Additional Redis Streams workloads | unselected workload-specific candidate | extend/reuse only after workload evidence qualifies it |
| JetStream | not authorized | Phase-5 entry gate requires a reproduced material Redis limitation |

## Relationship to APDM

At the frozen ActivityPods baseline, APDM Phase 10 is already closed. ADSP consumes APDM evidence but does not advance APDM gates, and APDM does not advance ADSP gates by implication.
