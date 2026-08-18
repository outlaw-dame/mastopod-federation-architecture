# ADSP Invariants

These invariants apply to every ActivityPods Distributed Scalability Program phase. A performance win that violates an invariant is not promotable.

## Authority and semantics

1. ActivityPods/SemApps remains authoritative for Pod state, LDP/WebACL semantics, local ActivityPub execution, recipient planning, signing/key custody and any authority already assigned to Tier 1 by APDM.
2. The Fedify sidecar remains the external ActivityPub HTTP execution authority in APDM `external` mode. Transport experiments must not recreate a second remote executor.
3. Distribution must not weaken per-Pod dataset isolation, WebACL enforcement, collection/inbox ordering guarantees or authoritative mutation semantics.
4. Existing APDM delivery-plan and durable-handoff contracts remain valid unless a separate explicitly versioned migration changes them.
5. A remote Moleculer call must preserve the same application-level meaning as the corresponding local call, including RDF/JSON-LD payload semantics, errors and metadata.

## Locality

6. Local calls remain local when caller and target service are intentionally colocated.
7. Tightly coupled Tier 1 services must not be separated merely to increase the number of independently deployable processes.
8. The default low-resource deployment must not require a network broker when a single-process ActivityPods deployment is sufficient.
9. Service grouping must be explicit and testable; accidental remote execution caused by duplicate/uncontrolled service registration is a correctness defect.

## Moleculer fabric safety

10. Every concurrently running Moleculer broker instance has a unique node ID.
11. Every distributed environment has an explicit namespace/isolation boundary. Dev/test/prod fabrics must not discover one another accidentally.
12. Serializer choice is independent of transporter selection. Changing Redis to NATS must not implicitly change payload semantics.
13. Invalid distributed configuration fails closed or to a documented safe single-node fallback; it must not silently join an unintended fabric.
14. Node departure, stale service discovery and rejoin behavior must be bounded and observable.

## Redis preservation

15. Redis is existing infrastructure, not technical debt to remove by default.
16. Existing Redis state/cache responsibilities remain unchanged unless a separate measured change justifies moving them.
17. Existing durable Bull/Fedify queue paths remain unchanged unless a workload-specific evidence gate proves a replacement materially better.
18. Redis Streams may be introduced only for workloads that require stream semantics or where measured evidence demonstrates a material advantage over the existing queue primitive.
19. Redis failover and replication semantics must be evaluated against the durability requirement of each promoted stream workload.

## NATS and JetStream containment

20. NATS Core may be adopted only as a Moleculer transport/profile when Phase 3 evidence justifies the additional runtime.
21. NATS Core adoption does not imply JetStream adoption.
22. JetStream may not enter the architecture merely to make NATS durable. It requires a reproduced workload limitation that Redis Streams/existing queues cannot adequately satisfy.
23. If NATS or JetStream is not promoted, experimental code/configuration must not become a mandatory dependency of normal deployments.

## Durability and idempotency

24. Accepted ActivityPub delivery intents are not lost during transporter, node or worker failure.
25. Retry/recovery must not duplicate authoritative Pod mutations or external federation execution.
26. Any durable stream/queue consumer has an explicit idempotency strategy, retry bound, poison-message handling policy, retention horizon and replay policy.
27. Recovery correctness is evaluated under process crash, broker disconnect, Redis/NATS restart where applicable, node loss and delayed consumer recovery.

## Resource efficiency

28. A candidate is evaluated on whole-system useful work, not isolated broker microbenchmarks.
29. Measurements include ActivityPods, Fuseki/TDB2, Redis, sidecar/Fedify, and NATS/JetStream when present.
30. Added infrastructure must earn its CPU, memory, network, storage and operational cost through measurable system-level benefit.
31. A result that merely shifts CPU, queue pressure or latency to another component is not a scalability win.
32. Tail latency, throughput and resource use are evaluated together; improving mean latency while materially worsening p99, memory, failure recovery or correctness is not sufficient.

## Benchmark integrity

33. Candidate comparisons use the same topology except for the variable under test.
34. Workloads, seeds, payloads, replica counts, resource limits, warmup policy and measurement windows are frozen before comparative runs.
35. Failed/partial/incomplete delivery samples cannot be counted as successful performance samples.
36. Exact repository heads, configuration, environment and run/artifact identifiers are recorded for promoted evidence.
37. Benchmark thresholds are locked after baseline variance is measured and before the candidate arm is used for promotion decisions.
38. No technology is promoted from a single favorable run.

## Compatibility and rollback

39. Single-node ActivityPods remains supported unless a separate explicit product decision changes that requirement.
40. Every promoted distributed profile has a documented rollback path to the preceding supported profile.
41. ActivityPods core compatibility remains a design constraint: scalability changes should be narrowly integrated, fail closed on pinned upstream assumptions where patching is unavoidable, and avoid unnecessary forks of SemApps behavior.
42. APDM and ADSP status are independent. Completing an ADSP phase must not falsely mark an APDM phase complete, or vice versa.
