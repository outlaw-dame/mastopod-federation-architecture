# OS4b — Measured OpenSearch batching

Status: planning/measurement slice after OS4 replay hardening.
Base: `6b1223a3eeea85b9b41bfeec988ddea3ec48e979`.

## Goal

Measure whether bounded OpenSearch `_bulk` writes materially improve the canonical Tier-3 lexical projection before changing offset/alias/tombstone semantics.

## Invariants

- no Kafka offset resolves before the corresponding OpenSearch side effect succeeds;
- tombstones and delete-by-author boundaries flush prior buffered writes;
- alias-cache updates occur only after successful OpenSearch writes;
- completion markers are written only after the corresponding projection succeeds;
- failures remain replayable and DLQ ordering from OS4 is unchanged;
- no per-write forced refresh is reintroduced.

## Candidate batch policy

Test current individual writes against bounded bulk sizes 25, 100, 250, and 500 with flush bounds of 50 ms, 250 ms, and 1 s. Measure on OpenSearch 3.8 using the active lexical `public-content-v1` mapping and representative ActivityPub public-content documents.

Metrics: docs/s, client CPU, OpenSearch container CPU, settled RSS, request p50/p95/p99, end-to-end ingest p50/p95/p99, disk delta, correctness, and post-refresh search visibility.

The implementation phase will choose the smallest batch/flush combination on the Pareto frontier that materially improves throughput/resource efficiency without creating unacceptable tail latency. If no candidate materially improves the current path, OS4b will retain individual writes and record the negative result rather than add buffering complexity.