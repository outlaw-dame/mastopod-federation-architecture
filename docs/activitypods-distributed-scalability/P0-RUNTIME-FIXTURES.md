# ADSP-P0 runtime fixtures

Date: 2026-08-18

This document freezes the executable-evidence split for ADSP Phase 0. It prevents later transporter work from changing workload semantics, mixing unrelated costs, or using a local-only benchmark to make whole-system federation claims.

## Evidence rule

ADSP-P0 uses **two complementary runtime fixtures**:

1. **Fixture A — Tier-1 ActivityPods local fanout**, isolating the current colocated Pod/SemApps cell; and
2. **Fixture B — mixed/remote federation**, including the authoritative external handoff, Fedify sidecar, incumbent Redis Streams durability, RedPanda public event logging, ActivityPods signing and controlled remote HTTP.

Both fixtures are now executable and have produced accepted P0 evidence. Exact results are recorded in `P0-TIER1-RUNTIME-EVIDENCE.md` and `P0-REMOTE-RUNTIME-EVIDENCE.md`.

Neither fixture substitutes for the other.

## Fixture A — Tier-1 local fanout

Status: **COMPLETE for frozen P0 local scope**.

Validated implementation: ActivityPods PR #82.

Accepted run: `32070748744`.

### Reused authority path

The fixture reuses the existing APDM real-workload machinery rather than a synthetic Moleculer microbenchmark:

- normal account signup;
- normal Pod/bootstrap completion barrier;
- real `activitypub.outbox.post` roots;
- real detached local ActivityPub delivery completion;
- existing Tier-1 instrumentation for nested Moleculer actions, CPU/RSS and Fuseki HTTP work.

### Frozen workload matrix

Canonical recipient counts:

- 1
- 10
- 100
- 200
- 1000

The accepted run used five successful measured samples per case after warmup. Failed, partial or semantically incorrect work is never accepted as an efficiency improvement.

### Frozen controls

- `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED=false`;
- federation sidecar excluded;
- local-delivery concurrency recorded explicitly;
- one benchmark image reused within the run;
- Fuseki and Redis start from fresh isolated state.

### Evidence emitted

- exact commit/run provenance;
- host/runtime/image provenance;
- elapsed time and CPU;
- RSS/heap evidence;
- nested Moleculer action counts;
- Fuseki request counts;
- Redis command/memory snapshots;
- supporting Docker stats;
- p50/p95/p99, standard deviation and coefficient of variation;
- normalized per-recipient elapsed/CPU/action/Fuseki metrics.

The summary explicitly records `federationSidecar: false`.

### Accepted interpretation

Fixture A establishes a reproducible single-cell Tier-1 workload and baseline variance. It does not establish sidecar throughput or external delivery cost.

The N=1 elapsed result is very noisy and is not used as a precise comparison threshold. N=10–1000 is substantially more stable and is the appropriate basis for later materiality rules.

## Fixture B — mixed/remote federation

Status: **COMPLETE for frozen P0 correctness/failure scope**.

Validated implementations:

- ActivityPods PR #83, merged as `7a727f52ba783added771f87693afbcb4fd8c536`;
- federation PR #80, merged as `2cd1c097456756c8c28d349dfc800d36cfd6fce6`.

Accepted whole-system run: `32086514942`.

### Frozen authority path

```text
ActivityPods activitypub.outbox.post
        ↓
authoritative ap.delivery-plan.v1
        ↓
exactly one suppressed native remotePost
        ↓
ActivityPods durable Bull handoff
        ↓
Fedify sidecar durable 202 acceptance
        ↓
Redis Streams outbox-intent
        ↓
RedPanda Stream1 + AP firehose publication
        ↓
Redis Streams outbound
        ↓
ActivityPods signing boundary
        ↓
controlled remote HTTP target
        ↓
completion / retry / DLQ reconciliation
```

Benchmark code does not construct a second Delivery Plan and does not submit a second sidecar handoff.

### Controlled outcomes

The accepted run executed all three cases:

- **success** — one controlled HTTP request, final `202`;
- **transient** — two injected `503` responses followed by `202`, with normal bounded retry intervals and three total requests;
- **permanent** — one injected `410`, classified permanent and moved to outbound DLQ.

Every case required:

- exact Activity/intent/target identity;
- positive RedPanda publication marker;
- immutable reconciled request body hash;
- no controlled-target contamination;
- zero final reconciliation errors;
- durable queue state consistent with the expected outcome.

### Signing boundary

The live fixture uses the real ActivityPods signing service. Before the accepted run, its AP authority check was repaired so it:

- proves the actor is bound to an actual local `auth.account`;
- proves the ActivityPub actor resolves to that exact WebID;
- resolves the actor-controlled RSA key through the real SemApps key service with the account dataset context;
- derives key ID from signer-controlled attached key metadata;
- fails closed for remote, nonexistent, mismatched or ambiguous actor/key authority.

The controlled target observed valid `Date`, `Digest`, and `Signature` headers.

### Supporting metrics/evidence

The artifact retains:

- ActivityPods and sidecar process snapshots;
- Docker stats;
- Redis commandstats/memory snapshots;
- RedPanda topic descriptions;
- controlled-target observations;
- service logs;
- per-case prepare/origin/settlement evidence.

Fixture B currently has one deterministic correctness run per scenario. It is accepted as correctness/failure-path evidence, not as a stable remote-delivery p50/p95/p99 performance distribution.

## RedPanda public-stream contract

A separate real-broker proof, run `32086514958`, freezes the ActivityPub public-stream semantics used by Fixture B and later phases:

- **Stream1** — `ap.stream1.local-public.v1`: aggregate local public ActivityPub activities for this Pod provider;
- **Stream2** — `ap.stream2.remote-public.v1`: aggregate remote public ActivityPub activities from accepted remote sources, including relay/service ingress where applicable;
- **AP firehose** — `ap.firehose.v1`: exactly Stream1 + Stream2;
- **tombstones** — `ap.tombstones.v1`: separate from the AP firehose;
- **canonical intents** — `canonical.v1`: separate protocol-neutral log, not part of the AP firehose.

The proof used the production RedPanda producer against a real isolated broker, then consumed all relevant topics. It observed one local proof event only in Stream1, one remote proof event only in Stream2, both exactly once in the firehose, and the tombstone only in its dedicated topic.

## Relationship to transporter comparison

ADSP-P2/P3 must not rewrite these workloads to favor one transporter.

For Redis-transporter versus NATS-Core comparison:

- useful application outcomes stay fixed;
- ActivityPods service grouping stays fixed;
- sidecar Redis Streams remain unchanged;
- RedPanda public-stream semantics remain unchanged;
- Redis state/cache/queue roles remain unchanged;
- Fuseki configuration stays fixed;
- only the Moleculer distributed transporter and minimum transport-specific configuration may differ;
- exact provenance and resource envelopes are recorded for both arms;
- JetStream is prohibited from the comparison.

Fixture A protects the Tier-1/locality side of this contract. Fixture B protects the federation/whole-system side.

## Current P0 gate state

- Fixture A: **COMPLETE**.
- Fixture B: **COMPLETE for frozen correctness/failure scope**.
- Real RedPanda Stream1/Stream2/AP-firehose semantics: **COMPLETE**.
- Exact numerical Phase-2/Phase-3 promotion thresholds: **NOT YET FROZEN**.
- ADSP-P0 therefore remains **IN PROGRESS** until those thresholds are written before any NATS result is observed.
- Multi-node namespace, transport-independent serializer, RDF remote parity, locality groups and node join/leave/rejoin are Phase-1 work per `PHASES.md`.
- No NATS or JetStream implementation is authorized by this document.
