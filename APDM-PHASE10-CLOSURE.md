# APDM Phase 10 closure

ActivityPods APDM Phase 10 is closed as **PASS with production-default promotion declined**.

The only authoritative paired promotion evidence is ActivityPods GitHub Actions run `31989314315` at source head `473cf27b7af20c658d6241cc251b7c822c2172cc`. Earlier runs `31980969664` and `31988013688` are superseded and must not be used for the production-default decision.

The run validated fresh per-arm Fuseki and Redis state, one runner and one backend image, concurrency 4, canonical N=1/10/100/200/1000 workloads, matched provenance/resources, zero measured delivery failures, and the intended dataset-existence mechanism. At N=1000 the enabled arm reduced median elapsed time by about 46%, CPU time by about 49%, total Fuseki requests by about 91%, and attempted `triplestore.dataset.exist` actions from 10,001 to 2.

The implementation was merged in ActivityPods PR #67, but the memo remains fail-closed. `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED` must be exactly `true` to enable it.

No production-default promotion PR is justified by this evidence. The paired workflow always ran OFF before ON, and the ON N=1 samples contained large elapsed-time outliers. That fixed-order/tail sensitivity prevents a defensible default-on decision even though the large-fanout mechanism and resource reduction are clear. Rollback/default behavior therefore remains memo OFF.

This closes the Phase 10 decision without weakening the architecture-wide rule that resource work must preserve latency/tail behavior, correctness, authority, durability, and interoperability.

## Phase 11 handoff

The post-Phase-10 N=1000 ON arm shows the next measured ActivityPods bottleneck is repeated `triplestore.query` work (~15,999 calls, about 7.1 seconds cumulative median action duration), followed by per-recipient dataset creation/insert/update work. Dataset-existence checks are no longer material.

Phase 11 should begin with query attribution in the real local-delivery lineage before considering batching: identify query call sites/shapes, separate authority-critical reads from redundant repeats, measure their counts/durations, and only then evaluate bounded reuse, selective reads, or batch-safe persistence. Pod/dataset boundaries, LDP, WebACL, ActivityPub, signing authority, partial-failure isolation, and rollback semantics remain non-negotiable.
