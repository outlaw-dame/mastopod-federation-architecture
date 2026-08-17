# ADSP Status

Last updated: 2026-08-17

This file is the live cross-repository evidence ledger for the ActivityPods Distributed Scalability Program. `PHASES.md` defines the roadmap and exit gates. `BENCHMARK-CONTRACT.md` defines evidence validity and promotion rules.

## Gate semantics

- **PASS / `[x]`** — the phase exit gate is closed.
- **IN PROGRESS / `[ ]`** — implementation or investigation may exist, but required evidence/correctness/promotion gates remain open.
- **BLOCKED / NOT STARTED** — dependent work must not be treated as completed or selected architecture.
- **NOT REQUIRED** — a conditional phase's entry gate never opened because the preceding architecture satisfied the requirement without the additional subsystem.

## Program checklist

- [ ] ADSP-P0 — baseline, authority and benchmark contract — **IN PROGRESS**
- [ ] ADSP-P1 — safe distributable Moleculer fabric — blocked by P0
- [ ] ADSP-P2 — horizontal ActivityPods / Redis transporter — blocked by P1
- [ ] ADSP-P3 — NATS Core transporter comparison — blocked by P2
- [ ] ADSP-P4 — qualified Redis Streams workloads — conditional
- [ ] ADSP-P5 — JetStream evaluation — conditional / entry gate closed by default
- [ ] ADSP-P6 — deployment profiles and stabilization — blocked by selected architecture

## Current architectural baseline

The program begins from these already-established constraints:

- ActivityPods/SemApps owns Tier 1 Pod/LDP/WebACL/triplestore semantics and authoritative ActivityPub planning.
- Fedify sidecar owns Tier 2 external ActivityPub HTTP execution in APDM `external` mode.
- Redis already exists in the architecture and must be treated as incumbent infrastructure rather than ignored when comparing new systems.
- local Moleculer calls should remain local where services are intentionally colocated.
- existing durable Redis/Bull/Fedify mechanisms remain in place until workload-specific evidence justifies changing them.
- NATS Core is a candidate for distributed Moleculer request/reply only; JetStream is not implied.
- Redis Streams is the first candidate for new durable event-stream semantics because Redis is already present.

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| ADSP-P0 | source/runtime baseline pending | program/benchmark docs established on setup branch; runtime baseline pending | IN PROGRESS |
| ADSP-P1 | not started | as needed | BLOCKED by P0 |
| ADSP-P2 | not started | evidence coordination later | BLOCKED by P1 |
| ADSP-P3 | not started | evidence coordination later | BLOCKED by P2 |
| ADSP-P4 | not started | not started | CONDITIONAL |
| ADSP-P5 | not started | not started | ENTRY GATE CLOSED |
| ADSP-P6 | not started | not started | BLOCKED |

## P0 known source findings to verify/freeze

Earlier repository analysis identified immediate distributed-fabric concerns that P0 must re-verify from the exact current ActivityPods head rather than treating historical observations as permanent facts:

- a static-looking Moleculer `nodeID` (`pod-provider`) was observed;
- the Moleculer transporter was selected from `CONFIG.REDIS_TRANSPORTER_URL || undefined`;
- RDF serializer configuration appeared coupled to whether the Redis transporter URL was present;
- the backend normally loaded many service schemas into one `moleculer-runner` process, making current locality substantially different from a fleet of one-service-per-process microservices.

These observations are hypotheses for P0 until exact current source paths, behavior and commit heads are recorded here.

## Existing evidence carried into ADSP

ADSP does not restart scalability research from zero. Relevant already-recorded evidence includes:

- APDM Phase 8/9 real local-delivery measurements showing large nested Moleculer/Fuseki amplification and bounded-concurrency gains without claiming that Moleculer transport itself is the root cause;
- `MOLECULER-FANOUT-SCALABILITY-RATIONALE.md`, which requires shared authoritative state to be resolved once, concurrency/memory to be bounded and whole-system cost to be measured;
- `docs/scalability-audit-2026-08-14.md`, including existing Redis/Fedify optimization findings and deliberately phased ActivityPods bottlenecks;
- `PORTABLE-BENCHMARKING-AND-CAPACITY.md` and `RESOURCE-EFFICIENCY.md` as supporting capacity/resource guidance.

## P0 evidence still required

Before P0 can pass, record:

1. exact ActivityPods and federation-architecture baseline commit SHAs;
2. exact current Moleculer broker configuration path and effective defaults;
3. node ID generation behavior under two simultaneous backends;
4. namespace behavior/default;
5. serializer selection and RDF payload behavior with and without a transporter;
6. default service-loading graph and identified locality groups;
7. Redis responsibility inventory across ActivityPods and Fedify sidecar;
8. baseline single-node whole-system resource matrix;
9. baseline measurement variance and locked Phase 2/3 promotion thresholds;
10. failure-test fixtures to be reused across candidate topologies.

## Decision ledger

No candidate technology has been selected by ADSP yet.

| Decision | State | Reason |
|---|---|---|
| Redis transporter for horizontal ActivityPods | comparator only | existing infrastructure; must first prove safe horizontal fabric |
| NATS Core | unselected candidate | test only after Redis horizontal baseline exists |
| Redis Streams | unselected workload-specific candidate | evaluate only for qualified durable event workloads |
| JetStream | not authorized for implementation/testing yet | Phase 5 entry gate requires a reproduced Redis limitation |

## Relationship to APDM

ADSP must not disturb the existing APDM sequence. APDM Phase 10 remains its own measured local metadata-round-trip work, followed by APDM P11–P16 according to that program's gates. ADSP may consume APDM evidence and later provide distributed-topology evidence, but neither program marks the other's phase complete by implication.
