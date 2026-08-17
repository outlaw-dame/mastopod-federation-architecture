# ADSP Benchmark Contract

This contract governs evidence used to promote an ActivityPods Distributed Scalability Program topology or messaging technology. Its purpose is to prevent apples-to-oranges comparisons and technology-first decisions.

## Unit of success

The unit of success is **correct completed application work at a known resource cost**, not raw broker messages per second.

A benchmark sample is valid only when the expected ActivityPods/ActivityPub operations complete with semantic parity and no unaccounted loss, duplication or partial execution.

## Whole-system measurement boundary

Every comparative run records, where applicable:

- ActivityPods process CPU, RSS, heap and event-loop health;
- request/action throughput and p50/p95/p99 latency;
- local versus remote Moleculer action counts;
- transporter request/reply volume, reconnects, timeouts and errors;
- Redis CPU, memory, command rate, connections and relevant queue/stream metrics;
- Fuseki/TDB2 HTTP/SPARQL request counts and latency;
- Fedify sidecar CPU, memory, queue depth, retries and completed external deliveries;
- NATS Core CPU, memory, connection/subscription counts and request/reply metrics when present;
- JetStream storage, consumer lag, redelivery/ack metrics and I/O when present;
- host/container CPU, memory and network ceilings;
- completed useful outcomes, failures, retries and duplicates.

A candidate that reduces one component's cost while moving equivalent or worse cost elsewhere is not considered an improvement.

## Workload classes

Phase 0 must freeze concrete fixtures for at least these classes before comparative promotion testing:

### W1 — Local Pod hot path

Exercises the existing ActivityPods authoritative local path with representative recipient fan-out while preserving APDM local-delivery semantics. This primarily protects against accidentally making tightly coupled Tier 1 calls remote.

Recommended canonical fan-out points reuse proven APDM sizes where practical: `N=1, 10, 100, 200, 1000`.

### W2 — Distributed Moleculer request/reply

Exercises service groups intentionally placed on different ActivityPods broker nodes. Include:

- small JSON request/reply;
- representative ActivityPub/Delivery Plan-shaped payloads;
- RDF/JSON-LD payloads requiring the configured serializer semantics;
- bounded concurrent requests;
- realistic error responses and timeouts.

This is the primary Redis-transporter versus NATS-Core comparison class.

### W3 — Mixed ActivityPods + federation workload

Combines Tier 1 ActivityPods work with accepted remote delivery intents and Fedify-sidecar execution so a faster internal transporter cannot hide regressions in Redis pressure, sidecar queues or total delivery latency.

### W4 — Background-worker candidate workload

Exercises a workload that can legitimately scale independently from the Pod/SemApps cell. This workload is used to validate service grouping and horizontal worker behavior.

### W5 — Durable event candidate

Defined only when a real workload requires ordered durable event semantics, replay, consumer groups and acknowledgements. It is the comparison basis for existing queue versus Redis Streams and, only if Phase 5 entry criteria open, Redis versus JetStream.

## Frozen comparison dimensions

For any A/B candidate comparison, the following remain identical unless the dimension itself is under test:

- repository commits;
- application code;
- service-group assignment;
- number of application replicas;
- CPU/memory limits;
- Redis topology/configuration;
- Fuseki dataset and storage state;
- Fedify-sidecar topology;
- input fixtures, identities and deterministic seeds;
- request concurrency and arrival pattern;
- warmup policy;
- sample duration/count;
- serializer;
- retry/timeouts at the application layer;
- network placement as far as the test environment permits.

For Phase 3, the intended variable is **Moleculer transporter only**: Redis transporter versus NATS Core. JetStream is prohibited from that comparison.

## Repetition and validity

Before Phase 2/3 promotion runs, Phase 0 must measure baseline variance and freeze a repetition policy.

Minimum rules:

- no candidate is promoted from one favorable sample;
- warmup samples are excluded consistently from all arms;
- failed, partial or semantically incorrect runs are not performance samples;
- each reported point includes the number of successful and rejected samples;
- medians and tail distributions are preferred over a single arithmetic mean;
- raw artifacts are retained when CI/runtime infrastructure permits.

Where practical, use at least three valid measured samples per canonical workload point, matching the evidence discipline already used by APDM local-delivery benchmarking.

## Failure matrix

A topology is not promotable until representative failures are tested.

Required scenarios by applicable phase include:

- ActivityPods worker/node process termination during load;
- Moleculer transporter disconnect and reconnect;
- newly started node joining the fabric;
- node disappearance and stale service-registry convergence;
- Redis interruption/restart appropriate to the deployment profile;
- NATS Core interruption/restart during Phase 3;
- sidecar process restart while durable intents exist;
- consumer crash after durable claim but before completion for stream/queue phases;
- delayed retry/recovery after temporary destination failure;
- duplicate/replayed producer input.

For every scenario record loss, duplication, recovery time, error surface and operator intervention required.

## Promotion thresholds

Exact numerical promotion thresholds must be frozen in Phase 0 **after baseline variance is known and before candidate results are used for a decision**. This avoids selecting thresholds after seeing which technology won.

The locked thresholds must cover:

- minimum material improvement required to justify added infrastructure;
- maximum allowable regression in p95/p99 latency;
- maximum allowable CPU/memory regression;
- correctness requirement: zero unexplained lost or duplicate authoritative outcomes;
- recovery requirement for node/broker failure;
- operational-cost penalty for an additional required runtime.

A candidate may also be rejected even when faster if its gain is too small to justify ongoing memory, deployment, monitoring, security and failure-domain cost.

## Phase-specific decision rules

### Phase 2 — Redis horizontal baseline

The goal is not to prove Redis is best. It is to establish a correct, reproducible multi-node ActivityPods baseline using existing infrastructure.

### Phase 3 — NATS Core

NATS Core is promoted only if matched evidence demonstrates a material whole-system advantage over the Redis transporter under one or more required distributed profiles and the operational cost is justified.

If the difference is within normal variance or too small to matter, Redis remains the transporter and NATS is removed from the required architecture.

### Phase 4 — Redis Streams

A workload is migrated/promoted only if it genuinely requires stream semantics or demonstrates a material advantage over the existing queue mechanism. Existing durable jobs are not moved merely for architectural uniformity.

### Phase 5 — JetStream

JetStream testing requires an already-reproduced Redis limitation. JetStream is promoted only for the workload/profile where its HA, partitioning, flow-control, throughput or recovery advantage materially exceeds the cost of operating a second durable subsystem.

## Evidence record

Every promoted decision records in `STATUS.md`:

- exact ActivityPods commit;
- exact federation-architecture commit;
- configuration/profile;
- benchmark/failure run IDs or artifact locations;
- successful/rejected sample counts;
- key performance/resource figures;
- correctness/failure result;
- promotion/rejection rationale;
- rollback profile.
