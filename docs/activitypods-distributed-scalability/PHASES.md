# ADSP Phases

This is the ordered cross-repository ActivityPods Distributed Scalability Program roadmap. `STATUS.md` carries the live evidence ledger, `P0-SOURCE-BASELINE.md` freezes source-level baseline facts and `BENCHMARK-CONTRACT.md` defines comparison rules.

## Completion rule

A checked phase means its **exit gate is closed**. Preparatory code, a successful unit test, a running distributed topology, or a faster single benchmark does not by itself complete a phase.

Later phases may not be promoted by assumption. NATS Core remains an unselected transporter candidate, additional Redis Streams use remains workload-specific, and JetStream remains gated behind reproduced limitations in the incumbent Redis durability model.

## Program checklist

- [x] Phase 0 — Freeze topology baseline, authority and benchmark contract — **COMPLETE**
- [x] Phase 1 — Safe distributable Moleculer fabric — **COMPLETE**
- [ ] Phase 2 — Horizontal ActivityPods with Redis transporter — **NEXT / unblocked by Phase 1**
- [ ] Phase 3 — NATS Core transporter comparison — blocked by Phase 2
- [ ] Phase 4 — Extend/reuse Redis Streams for qualified additional workloads — blocked by Phase 3 and workload evidence
- [ ] Phase 5 — Conditional JetStream evaluation — blocked unless a material incumbent Redis limitation is reproduced
- [ ] Phase 6 — Deployment profiles, stabilization and closeout — blocked by selected architecture

## Phase 0 — Freeze topology baseline, authority and benchmark contract

**Status:** COMPLETE  
**Slices:** `ADSP-P0-A`, `ADSP-P0-F`

Goals:
- verify current ActivityPods Moleculer node ID, namespace, transporter and serializer behavior from source;
- inventory which services are loaded into the default backend process and which calls are local today;
- freeze the existing Redis responsibilities on both sides of the architecture;
- freeze Fedify-sidecar durable queue/handoff behavior so transporter work cannot silently replace it;
- define representative workloads, measurement points, failure scenarios and promotion criteria before candidate testing;
- record exact repository heads used for the baseline.

Exit gate:
- [x] current source/runtime topology is verified in both repositories;
- [x] Redis responsibilities are classified as state/cache, incumbent durable queue/stream, or candidate additional workload;
- [x] baseline workload matrix and whole-system telemetry are reproducible;
- [x] benchmark variance is measured and comparison thresholds are locked before NATS testing;
- [x] APDM/Tier 1/Tier 2 authority boundaries are confirmed unchanged;
- [x] exact baseline heads and evidence runs are recorded in `STATUS.md`.

The numerical contract is frozen in `P0-PROMOTION-THRESHOLDS.md` and `BENCHMARK-CONTRACT.md`. No NATS-Core benchmark result was used to select those values.

## Phase 1 — Safe distributable Moleculer fabric

**Status:** COMPLETE  
**Primary:** `ADSP-P1-A`; federation slice only where integration/observability is needed.

Make ActivityPods safely distributable without changing the selected transporter yet.

Required work:
- unique node IDs for simultaneously running broker instances;
- explicit namespace/isolation suitable for dev, test and production fabrics;
- serializer selection independent of whether the Redis transporter URL is configured;
- selective service loading and explicit locality groups;
- a default Pod/SemApps cell that keeps tightly coupled Tier 1 services colocated;
- local-versus-remote action telemetry;
- real remote-call fixtures including RDF/JSON-LD payloads and errors;
- node join/leave/rejoin and stale-registry tests;
- fail-closed configuration for invalid distributed-mode settings.

Exit gate:
- [x] two or more ActivityPods broker instances can coexist without node-ID collision;
- [x] namespace prevents accidental cross-environment discovery;
- [x] serializer behavior is transport-independent and RDF semantic parity passes across a genuine remote call;
- [x] service groups can be started independently without loading every schema everywhere;
- [x] locality tests prove Pod/SemApps-cell calls remain local by default;
- [x] node loss/rejoin does not corrupt requests or silently duplicate authoritative work;
- [x] native single-process deployment remains a supported low-resource profile.

Phase-1 closeout evidence is recorded in `STATUS.md`. The node-loss gate deliberately proves the Moleculer fabric does not silently replay an already-committed mutation after its serving node is killed before response; it does not weaken Phase 2's stronger whole-system requirement to test real ActivityPub/Pod mutations under horizontal node loss.

## Phase 2 — Horizontal ActivityPods with Redis transporter

**Status:** NEXT / unblocked by Phase 1  
**Primary:** `ADSP-P2-A`; `ADSP-P2-F` for whole-stack measurement.

Establish the first valid distributed baseline using infrastructure already present in ActivityPods.

Topology:
- multiple ActivityPods backend replicas;
- Redis Moleculer transporter;
- Redis continues its existing state/cache/queue responsibilities;
- Fedify sidecar keeps its incumbent Redis Streams durability unchanged;
- tightly coupled Tier 1 services remain colocated according to Phase 1 locality groups.

Exit gate:
- [ ] matched 1-node and multi-node workloads complete with correctness parity;
- [ ] throughput, p50/p95/p99 latency, CPU, RSS/heap, Redis command/load, Fuseki work and error rates are recorded;
- [ ] scale-out efficiency is measured at at least 2 and 4 ActivityPods replicas where the environment permits;
- [ ] node loss under load has bounded, characterized recovery behavior;
- [ ] no accepted ActivityPub delivery intent or authoritative Pod mutation is lost or duplicated;
- [ ] this topology becomes the frozen comparator for Phase 3.

## Phase 3 — NATS Core transporter comparison

**Status:** BLOCKED by Phase 2  
**Primary:** `ADSP-P3-A`; `ADSP-P3-F` for whole-stack evidence.

Replace **only** the distributed Moleculer transporter with NATS Core. Redis remains unchanged for state/cache/existing queues and the Fedify sidecar keeps its incumbent Redis Streams durable path.

Comparison rule:
- same service grouping;
- same replica counts;
- same payloads and workload seeds;
- same host/resource limits;
- same serializer semantics;
- same warmup/sample policy;
- same failure injections;
- no JetStream.

Exit gate:
- [ ] Redis-transporter and NATS-Core arms both pass the correctness/failure matrix;
- [ ] matched performance evidence is complete under the locked benchmark contract;
- [ ] operational cost and added runtime complexity are explicitly scored;
- [ ] a promotion decision is recorded: keep Redis transporter, adopt NATS Core for a distributed profile, or gather more evidence;
- [ ] NATS is not retained merely because it is technically functional.

## Phase 4 — Extend/reuse Redis Streams for qualified additional workloads

**Status:** NOT STARTED / conditional  
**Slices:** assigned per workload; may be ActivityPods, federation, or both.

Redis Streams are already incumbent federation infrastructure. This phase therefore does **not** introduce Redis Streams to the architecture and does not rewrite the existing sidecar queues simply to satisfy the roadmap.

Evaluate reuse or extension of the existing Streams model only for an **additional new or refactored workload that genuinely requires stream semantics** such as ordered durable events, replay, consumer groups, acknowledgements or horizontally distributed workers.

The existing federation Streams implementation is part of the Phase 0/2/3 baseline and remains unchanged during the Moleculer transporter comparison. Working Bull-style queues or other established durability are not migrated merely for technology uniformity.

Entry/exit gate for each additional candidate workload:
- [ ] the workload's queue/stream semantics are classified before implementation;
- [ ] the incumbent queue mechanism cannot satisfy the requirement as simply or efficiently, or reusing Streams provides a measured material benefit;
- [ ] reuse of the existing Streams abstraction/topology is preferred over creating a duplicate queue implementation unless evidence requires separation;
- [ ] idempotency, retry, poison-message/DLQ, retention and replay bounds are explicit;
- [ ] Redis failover/data-loss semantics are tested against the workload's durability requirement;
- [ ] consumer-group recovery and pending-entry handling are proven where the workload uses them;
- [ ] memory growth and stream trimming behavior are bounded;
- [ ] workload-specific promotion or rejection decision is recorded.

If no additional workload qualifies, Phase 4 closes as **NOT REQUIRED FOR ADDITIONAL WORKLOADS**; the incumbent federation Redis Streams remain part of the architecture regardless.

## Phase 5 — Conditional JetStream evaluation

**Status:** BLOCKED unless a material incumbent Redis limitation is reproduced

JetStream is not part of the default plan. It may be evaluated only when a documented limitation in the incumbent Redis Streams/queue topology materially affects HA, partitioning, flow control, recovery, throughput, or operational safety for a required production workload.

Entry gate:
- [ ] a concrete Redis limitation is reproduced and quantified under the relevant existing or Phase-4-qualified workload;
- [ ] the limitation matters to a required production workload;
- [ ] application-level Redis partitioning/topology and simpler Redis-native options have been considered;
- [ ] the expected JetStream benefit is large enough to justify operating a second durable subsystem.

Exit gate:
- [ ] matched correctness, throughput and failure evidence exists for Redis and JetStream arms;
- [ ] duplicate durable-state operational burden is measured/documented;
- [ ] recovery, acknowledgement/redelivery and backpressure semantics are proven under failure;
- [ ] JetStream is adopted only for the profile/workload where it wins materially.

If the entry gate never opens, Phase 5 closes as **NOT REQUIRED**, not as a failed objective.

## Phase 6 — Deployment profiles, stabilization and closeout

**Status:** BLOCKED by selected architecture

Turn the evidence-backed result into explicit deployment choices rather than one mandatory heavyweight stack.

Expected profiles:
- low-resource/single-node ActivityPods profile;
- horizontal Redis-transporter profile if retained;
- horizontal NATS-Core profile only if Phase 3 earns it;
- incumbent federation Redis Streams preserved;
- additional Redis Streams use only for workloads promoted in Phase 4;
- JetStream only for workloads/profiles promoted in Phase 5.

Exit gate:
- [ ] deployment/configuration docs expose only evidence-backed profiles;
- [ ] rollback from distributed to simpler supported topology is documented and tested;
- [ ] capacity guidance includes CPU, memory, Redis and Fuseki constraints;
- [ ] observability and failure runbooks are complete;
- [ ] no experimental dependency remains mandatory without a closed evidence gate;
- [ ] final architecture decision and rejected alternatives are recorded in `STATUS.md`.
