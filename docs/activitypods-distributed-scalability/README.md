# ActivityPods Distributed Scalability Program (ADSP)

This directory is the authoritative cross-repository program for determining the lowest-resource, highest-throughput, safest distributed topology for ActivityPods/SemApps plus the federation sidecar.

ADSP is patterned after the existing ActivityPub Delivery Migration Program (APDM): it uses shared cross-repository phase IDs, explicit authority boundaries, invariants, measured exit gates, and a live evidence ledger. It is intentionally a separate program. ADSP work does **not** advance APDM phases unless an APDM exit gate explicitly depends on the same evidence.

## Repositories and authority

- `outlaw-dame/activity-pods` — ActivityPods/SemApps runtime authority: Moleculer broker configuration, service loading/locality, Pod/LDP/WebACL/triplestore semantics, local ActivityPub execution, RDF serialization behavior, and ActivityPods-side instrumentation.
- `outlaw-dame/mastopod-federation-architecture` — cross-stack architecture/evidence authority and federation runtime authority: Fedify sidecar, Redis-backed durable handoff/queues, federation workers, topology profiles, benchmark coordination, whole-system evidence and deployment guidance.

The existing APDM authority split remains unchanged. ActivityPods keeps Tier 1 Pod/data authority and authoritative delivery planning. The Fedify sidecar remains Tier 2 internet-facing ActivityPub execution in external mode.

## Program rule

One ADSP phase may contain one or more repository slices. Repositories do not maintain independent phase numbering.

- Cross-repo phases use `ADSP-P<n>`.
- ActivityPods slices use `ADSP-P<n>-A`.
- Federation-architecture slices use `ADSP-P<n>-F`.

A phase is complete only when its **exit gate** closes. Adding a transporter, queue, stream, benchmark harness, or deployment manifest does not by itself complete a phase.

## Core decision principle

Do not add a new distributed subsystem—or expand an incumbent one into a new workload—unless measured evidence shows that it improves the complete ActivityPods + federation stack on the dimensions that matter: throughput, tail latency, CPU, memory, Redis pressure, failure/recovery behavior, operational complexity, or cost.

Redis Streams are already incumbent federation infrastructure at the Phase 0 baseline. ADSP preserves those existing durable queues through transporter experiments. The evidence gate applies to **additional** Streams workloads, NATS Core, JetStream, or any other new distributed responsibility.

Preserve local execution when locality is cheaper and semantically safer. Distribution is introduced only where independent scaling pays for itself.

## Candidate progression

The experimental progression is deliberately ordered:

1. **Current baseline** — single ActivityPods broker, local Moleculer calls, existing Redis roles, and the existing sidecar Redis Streams durability path.
2. **Safe horizontal ActivityPods** — make the service fabric safely distributable and measure multiple backend replicas using the Redis transporter while leaving sidecar durability unchanged.
3. **NATS Core comparison** — same topology and workload, replacing only the distributed Moleculer transporter. Redis remains unchanged everywhere else, including the incumbent sidecar Streams queues.
4. **Additional Redis Streams workload evaluation** — only when a new or refactored workload independently demonstrates a need for durable ordered stream semantics; reuse the existing Streams model rather than creating a duplicate abstraction where practical.
5. **JetStream evaluation** — only if a reproduced material limitation in the incumbent Redis design justifies operating another durable subsystem.

NATS Core is therefore not a target architecture. It is a candidate transporter that must earn its place. JetStream is even more conditional.

## Locality rule

ADSP must not turn the normal high-frequency ActivityPods/SemApps chain into network hops merely because Moleculer can distribute it. Closely coupled operations such as ActivityPub, LDP, WebACL, triplestore and Fuseki-facing work should remain colocated unless measurement proves otherwise.

The likely scalable unit is a **Pod/SemApps cell** containing tightly coupled Tier 1 services, alongside independently scalable ingress, federation and background-worker groups where evidence supports separation.

## Current blockers before transporter comparison

The program begins by proving or correcting the service fabric itself, including:

- unique Moleculer node IDs for concurrently running instances;
- explicit namespace/isolation;
- transporter-independent serializer configuration;
- deliberate service-locality groups;
- selective service startup rather than every schema in every process;
- observability distinguishing local versus remote action execution;
- RDF payload semantic-equivalence tests across genuine remote Moleculer calls;
- deterministic node loss, rediscovery and retry behavior.

Until these are proven, Redis-versus-NATS benchmarks are not architecturally meaningful.

## Relationship to existing scalability work

ADSP consumes, but does not overwrite, existing evidence in:

- `docs/activitypub-delivery-migration/`;
- `docs/scalability-audit-2026-08-14.md`;
- `MOLECULER-FANOUT-SCALABILITY-RATIONALE.md`;
- `PORTABLE-BENCHMARKING-AND-CAPACITY.md`;
- `RESOURCE-EFFICIENCY.md`.

APDM local fan-out phases continue to optimize the authoritative Tier 1 execution path. ADSP answers a different question: how that already-correct system should be safely distributed and scaled across nodes and runtimes.

## Authoritative documents

- `PHASES.md` — ordered roadmap and exit gates.
- `STATUS.md` — live cross-repository evidence ledger.
- `P0-SOURCE-BASELINE.md` — frozen source-level Phase 0 topology and durability facts.
- `INVARIANTS.md` — correctness, locality, durability, compatibility and rollback requirements.
- `BENCHMARK-CONTRACT.md` — frozen comparison rules and promotion criteria.
