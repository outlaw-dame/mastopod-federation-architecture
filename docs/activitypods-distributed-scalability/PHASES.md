# ADSP Phases

This is the ordered cross-repository ActivityPods Distributed Scalability Program roadmap. `STATUS.md` carries the live evidence ledger and `BENCHMARK-CONTRACT.md` defines comparison rules.

## Completion rule

A checked phase means its **exit gate is closed**. Preparatory code, a successful unit test, a running distributed topology, or a faster single benchmark does not by itself complete a phase.

Later phases may not be promoted by assumption. In particular, NATS Core, Redis Streams and JetStream remain conditional candidates until their preceding evidence gates close.

## Program checklist

- [ ] Phase 0 — Freeze topology baseline, authority and benchmark contract — **IN PROGRESS**
- [ ] Phase 1 — Safe distributable Moleculer fabric — blocked by Phase 0
- [ ] Phase 2 — Horizontal ActivityPods with Redis transporter — blocked by Phase 1
- [ ] Phase 3 — NATS Core transporter comparison — blocked by Phase 2
- [ ] Phase 4 — Redis Streams for qualified durable event workloads — blocked by Phase 3 and workload evidence
- [ ] Phase 5 — Conditional JetStream evaluation — blocked unless Phase 4 exposes a material limitation
- [ ] Phase 6 — Deployment profiles, stabilization and closeout — blocked by selected architecture

## Phase 0 — Freeze topology baseline, authority and benchmark contract

**Status:** IN PROGRESS  
**Slices:** `ADSP-P0-A`, `ADSP-P0-F`

Goals:
- verify current ActivityPods Moleculer node ID, namespace, transporter and serializer behavior from source;
- inventory which services are loaded into the default backend process and which calls are local today;
- freeze the existing Redis responsibilities on both sides of the architecture;
- freeze Fedify-sidecar durable queue/handoff behavior so transporter work cannot silently replace it;
- define representative workloads, measurement points, failure scenarios and promotion criteria before candidate testing;
- record exact repository heads used for the baseline.

Exit gate:
- [ ] current runtime topology is source-verified in both repositories;
- [ ] Redis responsibilities are classified as state/cache, existing durable job, or candidate event-stream workload;
- [ ] baseline workload matrix and whole-system telemetry are reproducible;
- [ ] benchmark variance is measured and comparison thresholds are locked before NATS testing;
- [ ] APDM/Tier 1/Tier 2 authority boundaries are confirmed unchanged;
- [ ] exact baseline heads and evidence runs are recorded in `STATUS.md`.

## Phase 1 — Safe distributable Moleculer fabric

**Status:** BLOCKED by Phase 0  
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
- [ ] two or more ActivityPods broker instances can coexist without node-ID collision;
- [ ] namespace prevents accidental cross-environment discovery;
- [ ] serializer behavior is transport-independent and RDF semantic parity passes across a genuine remote call;
- [ ] service groups can be started independently without loading every schema everywhere;
- [ ] locality tests prove Pod/SemApps-cell calls remain local by default;
- [ ] node loss/rejoin does not corrupt requests or silently duplicate authoritative work;
- [ ] native single-process deployment remains a supported low-resource profile.

## Phase 2 — Horizontal ActivityPods with Redis transporter

**Status:** BLOCKED by Phase 1  
**Primary:** `ADSP-P2-A`; `ADSP-P2-F` for whole-stack measurement.

Establish the first valid distributed baseline using infrastructure already present in ActivityPods.

Topology:
- multiple ActivityPods backend replicas;
- Redis Moleculer transporter;
- Redis continues its existing state/cache/queue responsibilities;
- Fedify sidecar durability remains unchanged;
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

Replace **only** the distributed Moleculer transporter with NATS Core. Redis remains unchanged for state/cache/existing queues and the Fedify sidecar keeps its current durable Redis-backed path.

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

## Phase 4 — Redis Streams for qualified durable event workloads

**Status:** NOT STARTED / conditional  
**Slices:** assigned per workload; may be ActivityPods, federation, or both.

Evaluate Redis Streams only for **new or refactored workloads that require stream semantics**: ordered durable events, replay, consumer groups, acknowledgements and horizontally distributed workers.

This phase must not replace working Bull-style queues or Fedify durability without a workload-specific reason.

Exit gate for each candidate workload:
- [ ] queue/stream semantics are classified before implementation;
- [ ] existing queue cannot satisfy the requirement as simply or efficiently, or Streams provides a measured benefit;
- [ ] idempotency, retry, poison-message/DLQ, retention and replay bounds are explicit;
- [ ] Redis failover/data-loss semantics are tested against the workload's durability requirement;
- [ ] consumer-group recovery and pending-entry handling are proven;
- [ ] memory growth and stream trimming behavior are bounded;
- [ ] workload-specific promotion decision is recorded.

## Phase 5 — Conditional JetStream evaluation

**Status:** BLOCKED unless Phase 4 exposes a material limitation

JetStream is not part of the default plan. It may be evaluated only when a documented limitation in Redis Streams or the existing Redis queue topology materially affects HA, partitioning, flow control, recovery, throughput, or operational safety.

Entry gate:
- [ ] a concrete Redis limitation is reproduced and quantified;
- [ ] the limitation matters to a required production workload;
- [ ] application-level Redis partitioning/topology options have been considered;
- [ ] the expected JetStream benefit is large enough to justify a second durable subsystem.

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
- Redis Streams only for workloads promoted in Phase 4;
- JetStream only for workloads/profiles promoted in Phase 5.

Exit gate:
- [ ] deployment/configuration docs expose only evidence-backed profiles;
- [ ] rollback from distributed to simpler supported topology is documented and tested;
- [ ] capacity guidance includes CPU, memory, Redis and Fuseki constraints;
- [ ] observability and failure runbooks are complete;
- [ ] no experimental dependency remains mandatory without a closed evidence gate;
- [ ] final architecture decision and rejected alternatives are recorded in `STATUS.md`.
