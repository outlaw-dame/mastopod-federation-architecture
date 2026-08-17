# ADSP-P0 runtime fixtures

Date: 2026-08-17

This document freezes the executable-evidence split for ADSP Phase 0. It exists to prevent later transporter work from changing workload semantics, mixing unrelated costs, or using a local-only benchmark to make whole-system federation claims.

## Evidence rule

ADSP-P0 uses **two complementary runtime fixtures**:

1. a Tier-1 ActivityPods local-fanout fixture that isolates the current colocated Pod/SemApps cell; and
2. a mixed/remote federation fixture that includes the external handoff, Fedify sidecar and incumbent Redis Streams durability path.

Neither fixture substitutes for the other. P0 does not pass until both required scopes are represented by executable evidence and the remaining distributed correctness/failure gates are closed.

## Fixture A — Tier-1 local fanout

Implementation branch: `outlaw-dame/activity-pods:agent/adsp-p0-runtime-baseline`

Draft PR: `outlaw-dame/activity-pods#82`

Base: ActivityPods `3fad15838ec098d8d32c0f36cd8c75cbb66a46a8`.

### Reused authority path

The fixture deliberately reuses the existing APDM Phase 8/10 real-workload machinery rather than introducing a synthetic Moleculer microbenchmark:

- normal account signup;
- the normal Pod/bootstrap completion barrier;
- real `activitypub.outbox.post` roots;
- real detached local ActivityPub delivery completion;
- the existing APDM Tier-1 middleware that records nested Moleculer actions, CPU/RSS and Fuseki HTTP work.

The fixture therefore measures useful application work. It is not a broker messages-per-second test.

### Frozen workload matrix

Canonical recipient counts:

- 1
- 10
- 100
- 200
- 1000

Default measured sample floor: **5 successful samples per recipient count**, after at least one warmup root. The sample count is configurable upward, but a run may not claim completeness if any canonical case has fewer than the configured successful-sample floor.

Every measured trace must complete with zero delivery/instrumentation errors. Skipped, partial or failed work is not accepted as an efficiency improvement.

### Current-default controls

The fixture preserves the current ActivityPods production-default behavior at the frozen baseline:

- `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED=false` because APDM Phase 10 closed without promoting the memo to default-on;
- remote ActivityPub mode remains the local/native APDM benchmark setting;
- the federation sidecar is intentionally excluded from this fixture;
- local-delivery concurrency is explicitly recorded;
- one backend benchmark image is built and reused within the run;
- Fuseki and Redis start from fresh isolated bind-mounted state.

### Evidence emitted

Machine-readable evidence includes:

- exact commit SHA and GitHub run identity;
- host OS/architecture, CPU model/count and total memory;
- exact backend/Fuseki/Redis image identities;
- workload/sample/warmup/concurrency controls;
- per-sample elapsed time;
- backend user/system CPU;
- backend RSS/heap evidence from the existing instrumentation;
- nested Moleculer action counts;
- Fuseki request counts and request-shape evidence;
- Redis `INFO commandstats` and memory snapshots around the measured matrix;
- per-case container `docker stats` snapshots as supporting, not causal, evidence;
- p50/p95/p99, sample standard deviation and coefficient of variation;
- normalized-per-recipient elapsed, CPU, action and Fuseki-request metrics.

The summary explicitly records `federationSidecar: false` so this evidence cannot be presented as whole-system federation cost.

### What this fixture can establish

If the workflow passes and artifacts are inspected, Fixture A can establish:

- a reproducible single-cell Tier-1 workload;
- baseline local-delivery variance at the frozen ActivityPods source/runtime configuration;
- stable normalized work metrics suitable for later matched Redis-vs-NATS topology comparisons where the same application workload remains valid;
- a reference for determining whether a distributed topology merely moves or increases work.

It does **not** establish sidecar throughput, external HTTP behavior, Redis Streams durability, Redis failover behavior, or whole-system remote-delivery cost.

## Fixture B — mixed/remote federation

Status: **design frozen here; executable implementation pending**.

Fixture B must include the existing external-mode handoff and federation durability path without replacing any incumbent mechanism merely for benchmarking.

Required path:

```text
ActivityPods authoritative planning / handoff
        ↓
Fedify sidecar durable acceptance
        ↓
Redis Streams outbox-intent / outbound work
        ↓
sidecar worker + signing boundary
        ↓
controlled remote HTTP target
```

The remote target must be controlled and deterministic. The fixture must not depend on arbitrary public federation servers, internet latency, third-party rate limits or mutable remote behavior for promotion evidence.

### Required useful outcomes

The mixed/remote fixture must distinguish and count at least:

- authoritative handoffs accepted;
- remote intents durably represented;
- outbound jobs consumed;
- successful controlled remote deliveries;
- retries/deferrals where deliberately injected;
- completed-delivery markers;
- DLQ outcomes for explicitly permanent injected failures;
- duplicate/replay attempts suppressed by idempotency.

No throughput/resource result is valid if the expected durable outcomes do not reconcile.

### Required supporting metrics

At minimum:

- ActivityPods CPU/RSS and handoff latency/work;
- sidecar CPU/RSS;
- Redis command/stream/pending/memory evidence;
- queue residence/backlog/recovery behavior;
- signing calls and retry counts;
- controlled remote HTTP attempts/bytes;
- successful useful outcomes;
- p50/p95/p99 end-to-end completion latency;
- failure/retry/DLQ work per intended outcome.

### Failure cases

Fixture B must be reusable for later Redis-transporter and NATS-Core comparisons and therefore needs deterministic fault cases, including at least:

- sidecar worker interruption after durable enqueue;
- pending-entry reclaim after consumer interruption;
- transient controlled remote failure with exponential retry;
- permanent controlled remote failure to DLQ;
- duplicate intent/replay handling;
- Redis interruption/failover scenario appropriate to the configured durability model.

The Redis durability test must state what guarantee is being tested. Normal Redis asynchronous replication must not be described as stronger than it is.

## Relationship to transporter comparison

The ADSP-P2/P3 comparison must not rewrite these workloads to favor one transporter.

For the critical Redis-vs-NATS comparison:

- application workload and useful outcomes stay fixed;
- ActivityPods service grouping stays fixed;
- sidecar Redis Streams and existing queue/state responsibilities stay fixed;
- Fuseki configuration stays fixed;
- only the Moleculer distributed transporter and the minimum transport-specific configuration may differ;
- exact provenance and resource envelopes must be recorded for both arms.

Fixture A primarily protects the Tier-1/locality side of this contract. Fixture B protects the federation/whole-system side.

## Current gate state

At the time this document was added:

- Fixture A implementation exists in draft ActivityPods PR #82 and its workflow result is **pending**; no runtime numbers are accepted here yet.
- Fixture B executable implementation has not started.
- no P2/P3 promotion threshold has been locked from runtime variance yet;
- ADSP-P0 remains **IN PROGRESS**;
- ADSP-P1 remains blocked;
- no NATS or JetStream implementation is authorized by this work.
