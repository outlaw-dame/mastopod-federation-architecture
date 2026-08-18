# ADSP P0 Locked Promotion Thresholds

Status: **LOCKED BEFORE NATS RESULTS**  
Locked from Redis/incumbent baseline evidence on: **2026-08-18**

This document freezes the numerical decision rules for ADSP Phase 2 and Phase 3 before any NATS-Core benchmark result is generated or inspected. It converts the measured Phase-0 Redis/incumbent variance into explicit promotion/rejection gates.

These thresholds govern topology decisions. They do not authorize NATS, JetStream, or a new durable subsystem.

## Evidence used to set the noise floor

Authoritative ActivityPods Tier-1 baseline:

- workflow run: `32070748744`
- ActivityPods commit: `306e718b3d29a78f032d0545a0c66c22d533bb1f`
- artifact: `adsp-p0-tier1-32070748744-1`
- artifact digest: `sha256:e6975cfa3d2d1bdfc63142c0ac7be2f2ed92b9460ff198fe0b182bd1bcd4c6b8`
- measured samples: five per fan-out point after one warmup
- successful samples: 25/25
- canonical fan-out: `N=1,10,100,200,1000`

`N=1` is retained as correctness/smoke evidence but is excluded from numerical latency promotion decisions because elapsed CV was about 170%.

For the stable `N=10–1000` cases, the worst observed per-case coefficients of variation were:

| metric | worst stable CV | observed case |
|---|---:|---:|
| elapsed time | 3.85% | N=10 |
| completed-work CPU | 8.50% | N=10 |
| ending RSS | 15.55% | N=1000 |

The median stable elapsed CV was about 3.30%; the median stable CPU CV was about 2.17%. RSS was less stable and is therefore treated as a guardrail rather than a fine-grained winner metric.

These values are a **noise floor**, not candidate performance. No NATS result was used to choose any threshold below.

## Frozen sample policy

For Phase 2/3 matched comparisons:

1. Each arm must use identical workload seeds, service grouping, serializer, replica count, resource limits, application retries/timeouts and sidecar/Fuseki/Redis configuration except for the dimension explicitly under test.
2. Use at least one excluded warmup before measured samples at each canonical point.
3. Use at least **five valid measured samples per arm per point**. Failed or semantically incorrect attempts are reported but excluded from performance summaries.
4. Prefer running comparator and candidate arms on the same runner/host class and in the same workflow evidence set. If runner hardware differs materially, the comparison is invalid and must be rerun.
5. Report median, p95 and p99/tail observations; with only five samples, p95/p99 are conservative tail guards rather than high-resolution percentile estimates.
6. `N=1` may fail correctness gates but may not by itself promote or reject a transporter on latency.
7. A claimed gain must reproduce in at least **two required workload points**, including the highest tested representative load for that profile. One favorable point is insufficient.

## Universal correctness gate — zero tolerance

A Phase 2 or Phase 3 candidate is automatically rejected if matched valid evidence shows any unexplained:

- lost authoritative Pod mutation;
- lost accepted ActivityPub Delivery Plan;
- duplicate authoritative outcome;
- duplicate externally visible ActivityPub delivery caused by competing authorities;
- privacy/addressing semantic drift;
- RDF/JSON-LD semantic drift across a remote Moleculer call;
- partial completion reported as success.

Transport retries/redeliveries are permitted only when application-level idempotency reduces them to the same single authoritative outcome.

## Material-improvement gate

### In-place topology change with no additional required runtime

A change that does **not** add a required always-on runtime must demonstrate at least **10%** improvement in one primary whole-system metric at the required reproducible points, with no guardrail violation below.

Ten percent is more than 2.5 times the worst stable elapsed CV observed in the Phase-0 local baseline and is intentionally above normal latency noise.

### Candidate that adds a required runtime

A topology that adds a required always-on runtime — including NATS Core if Phase 3 reaches it — must demonstrate:

- at least **20% improvement** in one primary whole-system metric; **and**
- at least **10% improvement** in a second primary metric, or at least **20% higher completed-work throughput** under the same total resource ceiling.

Primary metrics are:

- completed-work p95 latency;
- completed-work CPU per successful application outcome;
- successful application throughput at the same resource ceiling.

A reduction confined to the new broker's own latency or CPU is not sufficient. The improvement must be visible at the whole-system measurement boundary.

The 20% threshold is deliberately much larger than the measured baseline noise and encodes the operational-cost penalty for introducing another process, deployment surface, security boundary, monitoring target and failure domain.

## Maximum regression guardrails

Even when the material-improvement gate is met, a candidate is rejected if the matched workload shows any of these sustained regressions at a required representative point:

| guardrail | maximum allowed regression |
|---|---:|
| completed-work p95 latency | +10% |
| completed-work p99/tail latency | +15% |
| total whole-system CPU per successful outcome | +15% |
| total whole-system median RSS | +20% |
| ActivityPods process median RSS | +20% |
| Redis CPU or command work attributable to the workload | +15% unless the candidate removes equivalent Redis transporter work and total whole-system CPU still passes |
| error/timeout rate | no statistically meaningful increase; any authoritative correctness error is zero-tolerance |

RSS is intentionally not used to declare a narrow winner because the Phase-0 RSS samples were noisier than latency/CPU. It remains a hard whole-system cost ceiling.

A candidate may be rejected even inside these ceilings if it merely moves equivalent work from ActivityPods/Redis into another process without satisfying the material-improvement gate.

## Phase 2 horizontal-scale gate

The Redis-transporter horizontal topology becomes the Phase-3 comparator only if it passes all correctness gates and demonstrates useful scale-out.

At matched offered load/resource limits:

- moving from 1 to 2 ActivityPods replicas must provide at least **1.50x** successful throughput, or reduce p95 latency by at least **20%** when the 1-node arm is demonstrably saturated;
- moving from 2 to 4 replicas, where the test environment permits, must provide at least **1.50x** successful throughput, or reduce p95 latency by at least **20%** under the same saturated-workload rule;
- adding replicas must not increase authoritative loss/duplication and must stay within CPU/RSS guardrails on a per-successful-outcome basis.

A topology that merely runs on more nodes without materially increasing useful capacity is not a successful horizontal baseline.

## Recovery/failure gate

For node/transporter interruption scenarios assigned to Phase 1–3:

- unexplained lost/duplicate authoritative outcomes: **0**;
- automatic recovery must require **no operator intervention** for the tested transient failure;
- after the failed/restarted dependency is again reachable, successful application request handling must resume within **30 seconds**;
- Phase-3 candidate p95 recovery time must be no worse than **1.25x** the matched Phase-2 Redis-transporter recovery p95, and must also satisfy the 30-second absolute ceiling;
- stale service-registry state must converge sufficiently to stop routing new work to the dead node within the same 30-second ceiling;
- queued/durable federation work keeps its existing APDM/Redis-Streams retry, replay-horizon and DLQ guarantees; the Moleculer transporter candidate is not allowed to weaken them.

If the Phase-2 Redis comparator itself cannot satisfy the 30-second ceiling, Phase 2 remains unpromotable until the distributed fabric is corrected; the ceiling is not relaxed after observing candidate behavior.

## Phase 3 NATS-Core decision rule

When and only when Phase 2 has produced the frozen Redis horizontal comparator, Phase 3 may replace **only** the Moleculer transporter with NATS Core.

NATS Core is promoted only if all of the following are true:

1. universal correctness gate passes;
2. failure/recovery gate passes;
3. 20% + 10% new-runtime materiality gate passes at at least two required representative workload points including the highest tested load;
4. no latency/CPU/RSS/Redis guardrail is violated;
5. the advantage remains whole-system-visible after counting the NATS process CPU/RSS and operational surface;
6. the result reproduces in a second matched evidence run or independently repeated evidence set.

If the measured difference is inside these thresholds, **Redis remains the Moleculer transporter and NATS Core is rejected for the required architecture**. Functional parity alone is not promotion evidence.

## Redis Streams and JetStream boundary

These thresholds do not authorize replacing existing Bull/Redis-Streams durability or adding JetStream.

- Existing sidecar Redis Streams remain incumbent during Phase 2/3.
- Additional Redis Streams workloads still require the Phase-4 workload-specific gate.
- JetStream remains prohibited unless Phase 5's separate entry condition reproduces a material Redis limitation first.

## Threshold immutability

Once this file is merged:

- these values may not be changed in response to Phase-2/3 candidate results;
- any future change requires a separately justified benchmark-contract revision based on new incumbent/baseline evidence, and that revision must occur **before** inspecting the affected candidate results;
- candidate evidence collected under a changed threshold contract must be rerun or explicitly declared non-decisional.
