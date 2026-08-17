# ADSP Status

Last updated: 2026-08-17

This file is the live cross-repository evidence ledger for the ActivityPods Distributed Scalability Program. `PHASES.md` defines the roadmap and exit gates. `BENCHMARK-CONTRACT.md` defines evidence validity and promotion rules. `P0-SOURCE-BASELINE.md` freezes the current source-level topology findings.

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
- [ ] ADSP-P4 — qualified extension/reuse of Redis Streams — conditional
- [ ] ADSP-P5 — JetStream evaluation — conditional / entry gate closed by default
- [ ] ADSP-P6 — deployment profiles and stabilization — blocked by selected architecture

## Program setup baseline heads

These are the exact `master` heads from which the ADSP setup branches were created. They are the source baselines frozen in `P0-SOURCE-BASELINE.md`; runtime/benchmark evidence must still record the exact heads actually executed.

- ActivityPods: `3fad15838ec098d8d32c0f36cd8c75cbb66a46a8`
- federation architecture: `e20c32fc5d4c9b9157de3063345e050ea3ec5007`

Setup branches:

- ActivityPods: `agent/adsp-program-baseline`
- federation architecture: `agent/activitypods-distributed-scalability-program`

## Current architectural baseline

The program now has source-verified evidence for these constraints:

- ActivityPods/SemApps owns Tier 1 Pod/LDP/WebACL/triplestore semantics and authoritative ActivityPub planning.
- Fedify sidecar owns Tier 2 external ActivityPub HTTP execution in APDM `external` mode.
- Redis already exists in the architecture and must be treated as incumbent infrastructure rather than ignored when comparing new systems.
- ActivityPods currently loads the broad backend service tree into one Moleculer runner, so the baseline is a colocated service cell rather than a one-service-per-process fleet.
- local Moleculer calls should remain local where services are intentionally colocated.
- existing durable Redis/Bull/Fedify mechanisms remain in place until workload-specific evidence justifies changing them.
- the federation sidecar already uses Redis Streams for durable inbound, outbound, outbox-intent and origin-reconciliation work queues, with consumer groups, pending-entry reclaim and bounded DLQ streams.
- NATS Core is a candidate for distributed Moleculer request/reply only; JetStream is not implied.
- any Phase 4 Redis Streams work means extending/reusing the incumbent Streams subsystem for an additional qualified workload, not introducing Streams to a system that lacks them.

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| ADSP-P0 | source broker/startup/Redis configuration frozen; runtime evidence pending | Redis Streams/signing caller baseline frozen; runtime evidence pending | IN PROGRESS |
| ADSP-P1 | not started | as needed | BLOCKED by P0 |
| ADSP-P2 | not started | evidence coordination later | BLOCKED by P1 |
| ADSP-P3 | not started | evidence coordination later | BLOCKED by P2 |
| ADSP-P4 | not started | incumbent Streams documented; additional workloads not selected | CONDITIONAL |
| ADSP-P5 | not started | not started | ENTRY GATE CLOSED |
| ADSP-P6 | not started | not started | BLOCKED |

## P0 source findings — frozen

Exact file-level evidence is recorded in `P0-SOURCE-BASELINE.md`. At the frozen heads, the earlier ActivityPods observations are now **confirmed**, not hypotheses:

- `pod-provider/backend/moleculer.config.js` uses the literal `nodeID: 'pod-provider'`;
- no explicit Moleculer namespace is configured;
- Moleculer transporter selection is `CONFIG.REDIS_TRANSPORTER_URL || undefined`;
- RDF serialization is selected by the Redis-specific transporter setting, coupling serialization semantics to transporter choice;
- `pod-provider/backend/package.json` starts a broad `moleculer-runner services/*.js services/**/*.js` service cell;
- `pod-provider/backend/config/config.js` exposes distinct Redis cache, transporter, queue and OIDC-state responsibilities.

Federation source verification also confirms:

- `fedify-sidecar/src/queue/sidecar-redis-queue-core.ts` already implements Redis Streams work queues;
- inbound, outbound, outbox-intent and origin-reconcile streams are separate;
- consumer groups use pending-entry `XAUTOCLAIM` recovery before `XREADGROUP` of new messages;
- stream and DLQ lengths are bounded;
- missing consumer groups are recreated;
- outbound retry/DLQ transitions durably insert replacement or DLQ work before ACKing the original Stream entry;
- successful delivery persists completed-delivery state before ACK;
- outbound retries use exponential backoff and preserve the greater of normal backoff and `Retry-After`;
- idempotency/delivery claims are separate from Stream pending ownership;
- atomic Redis Lua is already used for selected fanout, rate-limit and concurrency state transitions.

## Existing evidence carried into ADSP

ADSP does not restart scalability research from zero. Relevant already-recorded evidence includes:

- APDM Phase 8/9 real local-delivery measurements showing large nested Moleculer/Fuseki amplification and bounded-concurrency gains without claiming that Moleculer transport itself is the root cause;
- `MOLECULER-FANOUT-SCALABILITY-RATIONALE.md`, which requires shared authoritative state to be resolved once, concurrency/memory to be bounded and whole-system cost to be measured;
- `docs/scalability-audit-2026-08-14.md`, including existing Redis/Fedify optimization findings and deliberately phased ActivityPods bottlenecks;
- `PORTABLE-BENCHMARKING-AND-CAPACITY.md` and `RESOURCE-EFFICIENCY.md` as supporting capacity/resource guidance;
- APDM Phase 10 is closed at the frozen ActivityPods head; ADSP must not retain the stale setup wording that described it as still pending.

## P0 evidence still required

Before P0 can pass, record:

1. exact runtime-tested ActivityPods and federation-architecture commit SHAs;
2. effective node/discovery behavior under two or more simultaneous backends;
3. namespace/isolation behavior once a safe distributed fixture exists;
4. RDF payload semantic parity across a genuine remote Moleculer call;
5. default service-locality observations and local-versus-remote action telemetry;
6. baseline single-node whole-system resource matrix;
7. baseline measurement variance and locked Phase 2/3 promotion thresholds;
8. node disappearance/rejoin and stale-registry failure fixtures;
9. Redis failover/data-loss behavior for the incumbent Streams/queue workloads under the required durability model;
10. reusable failure-test fixtures for Redis-transporter and NATS-Core comparison.

## Decision ledger

No candidate technology has been selected by ADSP yet.

| Decision | State | Reason |
|---|---|---|
| Redis transporter for horizontal ActivityPods | comparator only | existing infrastructure; must first prove safe horizontal fabric |
| NATS Core | unselected candidate | test only after Redis horizontal baseline exists |
| Existing sidecar Redis Streams | incumbent / preserved | already powers durable federation work queues; not an ADSP candidate introduction |
| Additional Redis Streams workloads | unselected workload-specific candidate | reuse/extend only after a workload proves stream semantics are appropriate |
| JetStream | not authorized for implementation/testing yet | Phase 5 entry gate requires a reproduced Redis limitation |

## Relationship to APDM

ADSP must not disturb the existing APDM sequence. At the frozen ActivityPods baseline, **APDM Phase 10 is already closed** and Phase 11 is the next APDM-scoped local-delivery phase. ADSP may consume APDM evidence and later provide distributed-topology evidence, but neither program marks the other's phase complete by implication.
