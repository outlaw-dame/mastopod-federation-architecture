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

For Phase 2/3 decision evidence the locked minimum is **five valid measured samples per arm per required point after at least one excluded warmup**. A claimed gain must reproduce at two required representative points including the highest tested load for that profile. Comparator and candidate should run on the same host/runner class within the same evidence set; materially different runner hardware invalidates the comparison.

The Phase-0 `N=1` Tier-1 point is retained for correctness/smoke coverage but is excluded from precise latency promotion decisions because its measured elapsed CV was about 170%.

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

Exact numerical promotion thresholds are frozen here from Phase-0 incumbent evidence **before any NATS-Core result is generated or inspected**. The derivation and full rationale are recorded in `P0-PROMOTION-THRESHOLDS.md`.

Phase-0 stable Tier-1 points `N=10–1000` measured worst per-case CV of:

- elapsed time: **3.85%**;
- completed-work CPU: **8.50%**;
- ending RSS: **15.55%**.

These are noise floors, not candidate results.

### Locked materiality rules

- In-place topology change with no additional required runtime: at least **10%** improvement in one primary whole-system metric at the required reproducible points.
- Candidate adding an always-on required runtime: at least **20%** improvement in one primary whole-system metric **and** at least **10%** improvement in a second primary metric, or **20%** higher completed-work throughput under the same total resource ceiling.
- Primary metrics are completed-work p95 latency, completed-work CPU per successful application outcome, and successful application throughput at the same resource ceiling.
- Broker-local microbenchmarks cannot satisfy the materiality rule by themselves.

### Locked regression guardrails

A candidate is rejected if a required matched workload shows a sustained regression beyond:

- completed-work p95 latency: **+10%**;
- completed-work p99/tail latency: **+15%**;
- total whole-system CPU per successful outcome: **+15%**;
- total whole-system median RSS: **+20%**;
- ActivityPods median RSS: **+20%**;
- Redis CPU/command work attributable to the workload: **+15%**, unless equivalent Redis-transporter work is intentionally removed and total whole-system CPU still passes.

Correctness remains zero-tolerance: **0 unexplained lost or duplicate authoritative outcomes**, 0 privacy/addressing semantic drift, and 0 partial outcomes reported as success.

### Locked Phase-2 horizontal-scale rule

At matched offered load and resource limits:

- `1 → 2` ActivityPods replicas must yield at least **1.50x** successful throughput, or at least **20% lower p95 latency** when the 1-node arm is demonstrably saturated;
- `2 → 4` replicas, where the environment permits, must likewise yield at least **1.50x** successful throughput, or at least **20% lower p95 latency** under the same saturated-workload rule.

A multi-node topology that merely functions without materially increasing useful capacity does not become the Phase-3 comparator.

### Locked failure/recovery rule

- unexplained lost/duplicate authoritative outcomes: **0**;
- tested transient node/transporter failures recover automatically with **no operator intervention**;
- once the failed/restarted dependency is reachable again, successful application request handling and stale-registry convergence must recover within **30 seconds**;
- a Phase-3 candidate's p95 recovery time must be no worse than **1.25x** the matched Phase-2 Redis-transporter recovery p95 and must also satisfy the 30-second absolute ceiling.

If the Redis Phase-2 comparator cannot meet the absolute recovery ceiling, Phase 2 remains unpromotable; the threshold is not relaxed after candidate behavior is seen.

### Operational-cost penalty

The stricter `20% + 10%` rule for a new required runtime is the explicit operational penalty for another process, deployment surface, security boundary, monitoring target and failure domain. All CPU/RSS of the added runtime counts inside the whole-system measurement boundary.

A candidate may be rejected even when faster if its gain is too small to justify ongoing memory, deployment, monitoring, security and failure-domain cost.

Once merged, these thresholds cannot be changed in response to Phase-2/3 candidate results. A future contract revision requires new incumbent/baseline evidence and must be frozen before inspecting the affected candidate results.

## Phase-specific decision rules

### Phase 2 — Redis horizontal baseline

The goal is not to prove Redis is best. It is to establish a correct, reproducible multi-node ActivityPods baseline using existing infrastructure. It becomes the Phase-3 comparator only after satisfying the locked correctness, scale-out, resource and recovery gates above.

### Phase 3 — NATS Core

NATS Core is promoted only if matched evidence demonstrates a material whole-system advantage over the Redis transporter under one or more required distributed profiles and the operational cost is justified.

Because NATS Core adds a required runtime, it must satisfy the locked **20% primary + 10% secondary** materiality rule, all regression guardrails, all correctness/recovery gates, and reproduce the advantage in a second matched evidence set.

If the difference is within normal variance or below the locked materiality threshold, Redis remains the transporter and NATS is removed from the required architecture.

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
