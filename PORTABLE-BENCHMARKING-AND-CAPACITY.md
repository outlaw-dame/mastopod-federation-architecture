# Portable Benchmarking and Capacity Evidence

The ActivityPods + federation architecture is expected to run across heterogeneous infrastructure: shared VPS plans, dedicated-vCPU cloud instances, rented bare metal, colocated servers, home hardware, and provider-managed environments. Performance engineering therefore cannot depend on one cloud vendor or require a permanent DigitalOcean/Hetzner/Infomaniak/etc. test matrix.

The project uses a portable evidence model that separates mechanism/correctness claims from hardware-specific performance and from long-term capacity guidance.

## Evidence tiers

### Tier A — invariant and work-efficiency evidence

Tier A metrics should remain meaningful across hardware when workload and code provenance are equivalent:

- successful useful outcomes;
- protocol/authority/correctness invariants;
- datastore requests/updates per outcome;
- Redis/stream/queue operations per completed intent;
- remote HTTP attempts per successful delivery;
- bytes transferred or serialized for a fixed workload;
- duplicate resolution/materialization removed;
- retry/recovery work per completed delivery;
- batching/concurrency/page-size ceilings.

A different CPU model must not invalidate a hardware-independent claim such as a large reduction in redundant Fuseki requests. Conversely, unmatched hosts must not be used to claim a latency or CPU improvement.

### Tier B — controlled reference performance

Production-default decisions based on latency, CPU, memory, throughput or tail behavior require controlled evidence. Before/after or OFF/ON comparisons should use the same CPU model/count, memory envelope, OS/runner image, dependency/container artifacts, workload, sample count, concurrency configuration and fresh-state policy as far as practical.

When separate hosted runners cannot guarantee equivalent hardware, paired experiments may run sequentially on the same runner with freshly isolated application/datastore state.

GitHub-hosted runners are reference infrastructure, not a universal representation of customer deployments.

### Tier C — operator/community evidence

The architecture should eventually expose a standardized benchmark command that can run on real deployments and emit machine-readable evidence. Operator submission must be optional.

A portable result should record:

- source/version and installed runtime identity;
- ActivityPods and sidecar versions;
- enabled protocol/features;
- CPU model/count/architecture;
- RAM;
- OS/kernel/container runtime;
- storage characteristics when reliably known;
- shared/dedicated compute when operator-supplied;
- local and remote delivery workload shape;
- reconciliation/background workloads;
- ATProto workloads where enabled;
- CPU, RSS/heap, datastore work, network/queue work, elapsed time and success/failure counts.

Community results are observational evidence, not certification or ranking of hosting vendors.

## Deployment classes rather than provider brands

Capacity guidance should classify infrastructure by characteristics rather than by vendor:

| Class | Representative shape | Focus |
|---|---|---|
| Small shared | ~2 shared vCPU / 4 GB | idle cost, modest traffic, burst/noisy-neighbor tolerance |
| Small dedicated | ~2–4 dedicated vCPU / 8 GB | predictable sustained delivery |
| Medium dedicated | ~4–8 dedicated vCPU / 16 GB | concurrent accounts, federation and background work |
| Large dedicated | 8+ dedicated vCPU / 32+ GB | large fan-out, sustained federation and outage recovery |
| Bare metal/operator | operator-defined | upper-bound efficiency and storage behavior |

These are planning/evidence classes, not current minimum requirements. A DigitalOcean, Hetzner, Infomaniak, OVH, self-hosted or other machine maps to the closest class based on actual resource and sharing characteristics.

## Normalize work per useful outcome

Cross-service performance work should increasingly report stable normalized metrics such as:

- CPU-seconds per completed local delivery recipient;
- CPU-seconds per completed remote intent;
- Fuseki requests per local recipient;
- Redis operations per durable handoff;
- sidecar queue/retry operations per successful remote delivery;
- remote HTTP attempts/bytes per completed inbox delivery;
- peak RSS per representative concurrency level;
- reconciliation work per recovered intent;
- startup/background work per account;
- ATProto work per provisioning/repository operation.

This prevents faster hardware from hiding inefficient software and lets operators translate software work into their own infrastructure costs.

## Cost planning without pricing lock-in

Cloud prices, instance names and regions change frequently. Architecture decisions should therefore expose resource units rather than bake vendor prices into correctness/performance gates:

- CPU-seconds;
- RAM;
- datastore operations and bytes;
- disk growth;
- network bytes;
- queue/stream retention;
- sustained throughput;
- backlog recovery rate.

Operators can map those units to current local prices. The software evidence remains stable when a provider changes its catalog.

## Whole-system capacity

A complete capacity envelope must include both tiers and supporting infrastructure. It is insufficient to benchmark only one large local fan-out or only Fedify remote HTTP throughput.

Representative future capacity suites should include:

- concurrent posting accounts;
- mixed local/remote recipients;
- remote shared-inbox and individual-inbox delivery;
- inbound federation;
- ActivityPods handoff production;
- sidecar queue consumption and backpressure;
- Redis and optional stream infrastructure;
- retry/DLQ/outage recovery;
- ActivityPods reconciliation;
- follower synchronization/projections;
- Fuseki/TDB2 growth and disk/page-cache behavior;
- identity and ATProto provisioning/change-feed/repository work;
- restart, warm-start and migration behavior;
- sustained long-running memory/resource stability.

Capacity guidance must distinguish burst tolerance from sustainable throughput and backlog recovery.

## Provenance rules

Every significant benchmark artifact should carry enough information to answer:

1. What exact code and installed artifacts ran?
2. What workload and useful outcome were held constant?
3. Which configuration/concurrency values were active?
4. What hardware/runtime environment produced the result?
5. Which metrics are hardware-independent?
6. Which metrics require matched resources?
7. Were all required outcomes successful?
8. Was work removed, or only moved to another service/queue/datastore?

If hardware differs but a request-count mechanism is still valid, preserve that mechanism evidence while refusing to interpret unmatched latency/CPU as production evidence.

## Relationship to Phase 10

The Phase 10 dataset-existence experiment is the reference example for this policy.

Its first real OFF/ON measurement provided strong portable evidence that the memo removes redundant Fuseki dataset-registry traffic and materially reduces total Fuseki requests while deliveries succeed. However, separate hosted runners used different CPU families and independently built backend images, so that run is not valid evidence for latency/resource promotion.

The hardened experiment runs the two arms sequentially on one runner using one exact backend image, while rebuilding fresh application/datastore fixtures for each arm. This preserves the valid Tier A evidence and obtains valid Tier B evidence rather than weakening provenance requirements.

## Long-term outcome

Once controlled and operator evidence is sufficient, the project should be able to publish measured guidance for:

- practical small-provider resource footprints;
- local and remote throughput ranges by deployment class;
- idle CPU/RAM;
- Fuseki and storage considerations;
- shared versus dedicated CPU tradeoffs;
- concurrent-account/follower/activity envelopes under documented workloads;
- optional ATProto feature cost;
- expected bottleneck order and scaling/upgrade guidance.

Until those envelopes are established, documentation must distinguish measured facts, mechanism evidence, reference performance and provisional planning assumptions.
