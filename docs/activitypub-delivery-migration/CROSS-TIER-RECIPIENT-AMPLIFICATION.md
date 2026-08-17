# Cross-tier recipient-oriented federation amplification

> Status: architecture clarification. This documentation is independent of the frozen ActivityPods Phase 10 measurement run and does not modify that experiment's runtime source.

## The original scalability problem crossed both tiers

The ActivityPub scalability problem that motivated the Tier 1 / Tier 2 split was not limited to remote-delivery ownership. ActivityPods historically performed substantial recipient-oriented federation orchestration through Moleculer for both local and remote recipients.

The exact terminal work differed:

- local recipients ultimately require Pod-local LDP/WebACL/Fuseki persistence under ActivityPods/SemApps authority;
- remote recipients ultimately require signed ActivityPub HTTP delivery to remote inboxes.

But both paths could accumulate repeated per-recipient service calls, resolution, serialization, routing, and other work around shared sender/post state. The architectural response therefore has two halves.

## Local recipients: optimize inside Tier 1

Local Pod delivery cannot simply be moved to Fedify without changing authority. ActivityPods/SemApps must continue to own:

- recipient Pod and account authority;
- LDP resource persistence;
- WebACL semantics;
- collection updates and ActivityPub-local events;
- per-Pod Fuseki datasets;
- local partial-failure and recovery semantics.

The local optimization program therefore removes repeated work while preserving these boundaries: reuse authoritative context, eliminate duplicate lookup/materialization, reduce datastore round trips, batch only inside safe authority boundaries, use bounded concurrency, and eventually persist enough per-recipient recovery state to avoid replaying completed work.

## Remote recipients: Tier 2 is the scalability execution boundary

Remote federation had the same recipient-oriented orchestration smell, but its terminal operation is remote network delivery rather than Pod-local persistence. That made it suitable for a dedicated federation runtime.

In external APDM mode:

```text
ActivityPods / SemApps (Tier 1)
    authoritative post and recipient intent
    local-vs-remote classification
    signing/key authority
    durable delivery-plan production
            |
            v
Fedify sidecar (Tier 2)
    remote inbox execution
    shared-inbox collapse where valid
    bounded domain concurrency
    connection reuse
    retries/backoff/DLQ
    remote HTTP delivery
```

Tier 2 therefore exists for two related reasons:

1. **correctness/ownership** — prevent competing remote delivery routes and make one runtime responsible for remote HTTP execution;
2. **scalability/resource efficiency** — remove high-volume remote delivery execution from fine-grained recipient-by-recipient Moleculer orchestration and place it in a runtime designed for federation fan-out.

Treating Tier 2 as only an ownership cleanup understates the original architecture goal.

## What remains shared across the program

Both tiers should reduce work per successful delivery without weakening semantics:

- resolve shared state once when authority permits;
- avoid repeating recipient-independent lookups;
- keep batches bounded and authority-safe;
- bound concurrency, memory, queues, retries, and recovery bursts;
- collapse valid shared remote work such as shared inboxes;
- retain per-Pod isolation where local state cannot be collapsed;
- measure CPU, datastore I/O, network, queue work, latency, throughput, and recovery per useful outcome;
- never call work 'optimized' merely because its cost moved into another service.

## Canonical architectural statement

> Recipient-oriented Moleculer amplification was a cross-cutting local and remote federation scalability problem. Tier 2/Fedify is the remote execution solution to that class of problem; Tier 1/ActivityPods must optimize the local equivalent while retaining Pod-local LDP/WebACL/Fuseki authority and SemApps compatibility.
