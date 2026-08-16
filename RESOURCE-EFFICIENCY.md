# Resource Efficiency and Performance Principles

This architecture is designed not only to scale to larger workloads, but also to perform the same correct useful work with less compute and infrastructure.

That means reducing CPU, memory, datastore I/O, network traffic, queue churn, background work, and container footprint **without sacrificing latency, sustained throughput, correctness, durability, interoperability, security, or protocol authority**.

This is a cross-service objective covering ActivityPods, the Fedify sidecar, Redis, RedPanda, Fuseki/TDB2, and protocol integration paths.

## Distinction from scalability

Scalability and resource efficiency overlap but are not identical:

- **Scalability:** avoid pathological growth as users, recipients, followers, history, datasets, and queue depth increase.
- **Resource efficiency:** reduce the resources consumed per correct useful outcome at the same representative workload.
- **Performance:** preserve or improve latency, throughput, tail behavior, and backlog recovery while doing so.

A change is not successful merely because one container uses less CPU. It must be evaluated against total system work and useful outcomes.

## Core metrics

Where practical, architecture and performance work should measure:

- CPU-seconds per completed delivery or synchronization unit;
- peak and sustained RSS/heap under representative concurrency;
- datastore queries/updates and bytes per useful operation;
- Redis commands/queue entries/retries per completed intent;
- RedPanda messages/bytes per durable event where relevant;
- remote HTTP attempts and bytes per successful remote delivery;
- local ActivityPods ↔ sidecar requests/bytes per intent;
- queue backlog growth/recovery rate;
- P50/P95/P99 latency and sustained throughput;
- idle/startup/background CPU and I/O;
- disk growth and compaction cost;
- resource use during failure/retry storms.

Metrics should be normalized against successful useful work so that skipping, delaying, or silently losing work cannot look like an efficiency gain.

## ActivityPods / Tier 1 priorities

ActivityPods should minimize unnecessary work while preserving Pod, LDP, WebACL, identity, ActivityPub, and signing authority.

Priorities include:

- remove duplicate actor/account/dataset/inbox resolution;
- use selective indexed reads instead of population materialization;
- use bounded keyset/range paging rather than growing OFFSET scans;
- batch same-authority operations where Pod/dataset boundaries permit;
- reuse authoritative metadata only within narrowly bounded safe scopes;
- avoid full JSON-LD/RDF actor materialization when a single persisted predicate is authoritative;
- make compatibility migrations one-time rather than permanent warm-start population work;
- keep local-delivery concurrency bounded and empirically selected;
- reduce Fuseki/TDB2 requests, transfer, temporary materialization, and unnecessary updates before increasing JVM resources;
- keep ActivityPub and ATProto integrations from independently repeating equivalent expensive provider discovery/materialization.

The ActivityPods repo carries the detailed provider-wide scalability and resource-efficiency records.

## Fedify sidecar / Tier 2 priorities

The sidecar should minimize the cost of remote federation execution without moving authority out of ActivityPods.

Priorities include:

- one authoritative delivery intent rather than repeated recipient planning;
- shared-inbox collapse/deduplication where semantically valid;
- bounded per-domain concurrency and connection use;
- connection reuse/keep-alive where safe;
- bounded DNS/key/actor caches with correct invalidation and security boundaries;
- exponential retry/backoff rather than tight retry loops;
- avoid reexecuting completed intents through durable idempotency markers;
- bounded queue claim/read/cleanup batches;
- bounded delayed/retry structures;
- avoid oversized per-recipient payload duplication when common intent data can be represented once safely;
- stream and batch internal work where that reduces syscall/network/serialization overhead without creating latency cliffs;
- prevent queue backlog recovery from turning into a CPU/network burst that overwhelms ActivityPods, Redis, or remote domains.

## Cross-service rule: do not move waste

An optimization must consider the entire path.

Examples:

- moving recipient discovery from ActivityPods to the sidecar is not an efficiency win if the sidecar must redo authoritative work ActivityPods already performed;
- reducing ActivityPods CPU by sending much larger payloads can increase network/Redis memory cost and may be a net regression;
- reducing Redis commands by building giant in-memory batches can increase heap and tail latency;
- reducing remote HTTP count through shared-inbox collapse is useful when semantic delivery equivalence is preserved;
- reducing retries through durable completion evidence is useful because it removes actual repeated work.

The preferred design removes redundant work at its source rather than relocating it.

## Less compute without slower service

The target is a better efficiency frontier, not simply lower utilization.

Strong improvements often reduce both resource use and latency by:

- eliminating duplicate reads;
- reducing serialization/materialization;
- lowering request count;
- using selective indexes;
- collapsing duplicate remote targets;
- avoiding failed/replayed work;
- reusing established connections;
- batching bounded adjacent operations;
- keeping queues short enough that work is processed once rather than repeatedly reclaimed/retried.

When a change trades resource use against latency or throughput, the tradeoff must be explicit and measured. A production default should not be promoted solely because average CPU falls if P95/P99 latency or backlog behavior materially worsens.

## Idle and small-provider efficiency

The architecture should remain practical for small providers, not only large deployments.

Targets include:

- low idle CPU and memory;
- no unnecessary population scans on startup;
- no aggressive polling when event-driven or bounded incremental work is available;
- controlled sidecar/queue/stream retention;
- lazy/on-demand rebuilds where authority and recovery permit;
- configurable services so optional heavy components are not required for deployments that do not use their features;
- evidence-backed resource guidance rather than assuming large VM allocations.

A provider should not need excessive compute merely to remain online and interoperable.

## Failure-path efficiency

Failure handling is part of resource architecture.

Required properties include:

- exponential backoff with caps/jitter where appropriate;
- bounded retry counts or durable delayed retries;
- DLQ/quarantine paths for persistent failures;
- idempotency so crash recovery does not redo successful work;
- circuit-breaking/backpressure where a downstream service is unhealthy;
- bounded recovery concurrency after outages;
- no tight polling/retry loops that amplify a Redis, Fuseki, sidecar, DNS, or remote-domain outage.

Correct recovery should consume less work than blindly replaying the entire workload.

## Resource budgets and evidence

The project should move toward explicit resource budgets for representative small, medium, and large deployments, including:

- ActivityPods idle and active CPU/RSS;
- Fuseki heap/disk/page-cache and request rates;
- Redis memory, queue depth, command rates, and recovery load;
- sidecar CPU/RSS/socket concurrency;
- RedPanda memory/storage/network cost when enabled;
- local and remote delivery throughput;
- concurrent-account behavior;
- follower-sync and reconciliation backlog recovery;
- ATProto provisioning/repository/change-feed costs;
- startup and migration cost.

For significant performance/resource PRs, evidence should identify:

1. the useful outcome held constant;
2. the resource reduced;
3. before/after absolute and normalized metrics;
4. latency/throughput/tail impact;
5. correctness/security/durability invariants;
6. whether work was removed or merely moved/deferred;
7. the next likely bottleneck;
8. rollback behavior.

## Anti-goals

The following do not qualify as resource-efficiency improvements by themselves:

- dropping or truncating required work;
- weakening ActivityPub, ATProto, Pod, WebACL, LDP, or signing semantics;
- lowering concurrency until throughput becomes inadequate;
- using unbounded concurrency to hide inefficient per-item work;
- moving compute to another service without reducing total work;
- increasing cache staleness until mutable authority is wrong;
- hiding work in growing queues;
- increasing VM/container sizes before addressing avoidable duplicate/population work;
- disabling observability needed to understand production resource behavior.

## Architectural target

The desired system is not merely one that can scale horizontally with enough hardware. It should be **computationally economical**: larger workloads remain bounded and observable, while each delivery, synchronization, lookup, reconciliation, and protocol operation consumes as little CPU, memory, I/O, network, and queue work as correctness permits.

Performance, scalability, and efficiency are therefore co-equal architecture requirements.
