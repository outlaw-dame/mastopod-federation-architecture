# ADSP Status

Last updated: 2026-08-18

This is the live cross-repository evidence ledger for the ActivityPods Distributed Scalability Program. `PHASES.md` defines phase ownership and exit gates. `BENCHMARK-CONTRACT.md` defines evidence validity and promotion rules. Detailed Phase-0 evidence is in `P0-SOURCE-BASELINE.md`, `P0-TIER1-RUNTIME-EVIDENCE.md`, and `P0-REMOTE-RUNTIME-EVIDENCE.md`.

## Program checklist

- [ ] ADSP-P0 — baseline, authority and benchmark contract — **IN PROGRESS: runtime fixtures complete; numerical promotion thresholds still to freeze**
- [ ] ADSP-P1 — safe distributable Moleculer fabric — blocked by P0
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

## P0 gate reconciliation

`PHASES.md` assigns multi-node node IDs, namespace isolation, transport-independent serialization, RDF semantic parity across remote calls, explicit locality groups, and node join/leave/rejoin behavior to **Phase 1**. They are not unfinished Phase-0 requirements.

The remaining Phase-0 work is to freeze the numerical Phase-2/Phase-3 promotion thresholds from the measured baseline variance **before any NATS result is observed**. The locked values must cover:

1. minimum material whole-system improvement required to justify added infrastructure;
2. maximum p95/p99 latency regression;
3. maximum CPU/memory regression;
4. zero unexplained lost/duplicate authoritative outcomes;
5. bounded recovery behavior;
6. explicit operational-cost penalty for adding a required runtime.

After those values are recorded in `BENCHMARK-CONTRACT.md`, the written P0 exit checklist can be evaluated for closure. Until then P0 remains **IN PROGRESS** and P1/NATS/JetStream remain blocked.

## Decision ledger

| Decision | State | Reason |
|---|---|---|
| Redis transporter for horizontal ActivityPods | comparator only | existing infrastructure; valid comparator only after P1 |
| NATS Core | unselected candidate | test only after the P2 Redis horizontal baseline exists |
| Existing sidecar Redis Streams | incumbent / preserved | already provides durable federation work queues |
| RedPanda AP public streams | incumbent / verified | Stream1 local + Stream2 remote; AP firehose is their union |
| Additional Redis Streams workloads | unselected workload-specific candidate | extend/reuse only after workload evidence qualifies it |
| JetStream | not authorized | Phase-5 entry gate requires a reproduced material Redis limitation |

## Relationship to APDM

At the frozen ActivityPods baseline, APDM Phase 10 is already closed. ADSP consumes APDM evidence but does not advance APDM gates, and APDM does not advance ADSP gates by implication.
