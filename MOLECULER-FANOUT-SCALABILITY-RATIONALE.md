# Moleculer Fan-out Scalability Rationale

This architecture did not introduce Tier 2/Fedify only as a code-organization preference. It is also a response to a cross-cutting scalability problem in the historical ActivityPods/SemApps execution model.

## Shared root cause across local and remote delivery

Historically, one logical ActivityPub post could expand into repeated recipient-oriented work inside Moleculer. Local and remote paths did not execute the same actions, but they shared the same broad scaling shape:

- resolve or materialize recipient-related state repeatedly;
- invoke multiple service actions per recipient;
- perform nested datastore or serialization work underneath those actions;
- repeat work that could sometimes be resolved once or reused safely;
- couple wall-clock growth and resource use closely to recipient count.

The problem is therefore not accurately described as "Moleculer is slow." The problem is **recipient-oriented orchestration at fine service-call granularity**, where a fan-out operation is expressed as many repeated per-recipient action chains.

## Why the remedies differ

The shared root cause does not justify moving all fan-out work out of ActivityPods.

### Local delivery remains Tier 1

Local delivery mutates authoritative Pod state and depends on:

- per-Pod dataset isolation;
- LDP persistence semantics;
- WebACL enforcement;
- inbox/collection authority;
- activity attachment/linking;
- local account and identity authority.

Those responsibilities remain ActivityPods/SemApps Tier 1. The local scalability remedy is therefore to optimize the authoritative path in place: remove duplicate lookups, reuse already-authoritative request context, reduce Fuseki/LDP/WebACL round trips, batch only within valid authority boundaries, use bounded concurrency, and add durable per-recipient recovery.

The ActivityPods repo contains the measured local fan-out example and APDM P7-P12 work.

### Remote federation execution became Tier 2

Remote federation has a different authority profile. ActivityPods still owns authoritative planning, local/remote classification, signing-key custody, and policy-bearing state, but internet-facing execution can be separated safely.

That is why the Fedify sidecar exists as a dedicated Tier 2 federation runtime. It can apply federation-specific fan-out primitives that would otherwise remain entangled with recipient-oriented Moleculer execution:

- shared-inbox collapse/deduplication;
- bounded per-domain concurrency;
- HTTP connection reuse;
- remote actor/key/DNS cache boundaries;
- durable queue claims and idempotency;
- exponential retry/backoff;
- delayed retries and DLQ handling;
- backlog recovery and backpressure;
- remote HTTP execution independent of local Pod persistence.

This is a scalability boundary as well as an ownership boundary.

## Transitional duplication and APDM

Introducing a sidecar alone was not enough. During migration, native SemApps `remotePost` execution and a downstream sidecar routing path could coexist, creating duplicate routing/execution authority and repeated recipient/inbox work.

APDM P1-P6 resolves that transition deliberately:

1. ActivityPods produces the authoritative delivery intent;
2. the handoff is durable and idempotent;
3. production external mode suppresses native SemApps external execution;
4. the Fedify sidecar becomes the sole internet-facing ActivityPub HTTP executor;
5. native SemApps delivery remains a deterministic rollback mode rather than a simultaneous second path.

The result is not "move federation away from ActivityPods." It is **keep authority in ActivityPods while moving remote execution into the runtime designed to scale remote execution efficiently**.

## Local and remote are two manifestations of the same architectural lesson

The worked local example in ActivityPods demonstrates how recipient-oriented orchestration can produce large nested Moleculer/Fuseki amplification even without any network hop. Remote federation historically had the same class of repeated per-recipient orchestration plus additional HTTP/signature/retry costs.

The architecture therefore follows one common rule with two implementations:

- **resolve shared authoritative state once;**
- **do not repeatedly rediscover or re-execute already-known work;**
- **batch only where authority permits;**
- **bound concurrency and memory;**
- **make recovery idempotent;**
- **keep the execution engine appropriate to the work.**

For local Pod work, that engine remains ActivityPods/SemApps. For remote federation execution, that engine is the Fedify sidecar.

## Resource-efficiency implication

This split must reduce total system work, not merely move CPU from one process to another. Performance evidence should therefore account for ActivityPods, Fuseki/TDB2, Redis, the sidecar, network I/O, queue churn, retries, and completed useful delivery outcomes together.

Tier 2 succeeds when remote delivery becomes more scalable and resource-efficient **without** duplicating Tier-1 planning, weakening Pod authority, or hiding equivalent waste in another service.