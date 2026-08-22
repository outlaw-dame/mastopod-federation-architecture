# OS4 — Canonical ingestion, replay and backpressure hardening

Status: implementation / validation
Base: OS3 merge `3e941cc829b6dd4f22e3f3c172f13d60db533a4b`

## Canonical ingestion decision

OS4 designates `SearchIndexerService` as the sole canonical Redpanda -> Tier-3 public search projection for `ap.firehose.v1` and `ap.tombstones.v1`.

The historical Redpanda Connect `ap.firehose.v1 -> ap-activities` pipeline is removed from the active `redpanda-connect/streams/*.yaml` set and retained under `redpanda-connect/archive/` only as migration evidence. Running both paths created different public-search schemas and independent consumer groups, so they could not be treated as one coherent projection.

Redpanda Connect remains available for auxiliary pipelines whose responsibilities do not duplicate `public-content-v1` / `public-author-v1`.

## Reliability changes

### Explicit Kafka offset ownership

OS4 runs KafkaJS with `eachBatchAutoResolve: false`. The consumer therefore advances only offsets it explicitly resolves after successful handling. Returning from a paused batch cannot implicitly commit the failed event or later records from the fetched batch.

### Real KafkaJS pause/resume

Before OS4, `SearchIndexerService` called the KafkaJS `pause()` callback but discarded its returned `resume()` function. Clearing an internal Boolean did not resume a paused consumer.

OS4 stores that callback and invokes it after the bounded retry delay. Partition processing therefore resumes after transient OpenSearch failures.

### Post-success completion dedupe

The original OS4 prototype acquired a durable `outboxIntentId` claim before projection and attempted to release it after failure. Review showed that rollback leases introduce two loss/race modes: a Redis release failure can leave a stale claim that suppresses replay, and an unconditional delete can remove another worker's reacquired claim.

The canonical design therefore has no rollback lease. For events carrying an `outboxIntentId`, the sequence is:

1. check whether the completion marker already exists;
2. if complete, resolve the duplicate source offset without re-projecting;
3. otherwise perform the idempotent Tier-3 projection;
4. record the completion marker with bounded TTL;
5. explicitly resolve the source Kafka offset.

The OS4 completion namespace is `search:completed-outbox-intent:v1`, deliberately separate from the earlier `search:outbox-intent` pre-side-effect lease namespace. Old leases can therefore never be mistaken for proof that the OS4 projection completed.

If projection fails, no completion marker is written and the source offset remains unresolved. If completion recording is temporarily unavailable, the deduper can fall back to its process-local marker; the successful projection may be replayed later, but replay causes duplicate idempotent work rather than silent projection loss. That trade is intentional: at-least-once duplicate work is safer than a durable pre-side-effect claim that can suppress a missing projection.

### Bounded poison-message retries and governed DLQ

Search projection retries are bounded by `SEARCH_INDEXER_MAX_PROCESSING_ATTEMPTS` (default 5). An event that exhausts the limit is written unchanged to `SEARCH_INDEXER_DLQ_TOPIC`.

The default is the existing governed `ap.firehose.dlq.v1` topic rather than an OS4-only ad-hoc topic. Redpanda topic governance already provisions and verifies this DLQ across development/staging/production profiles, so production behavior does not depend on broker auto-topic creation. Search-indexer failures remain distinguishable through headers recording:

- source topic;
- source partition;
- source offset;
- failure message;
- attempt count;
- failure timestamp.

Only after the DLQ write succeeds is the source offset resolved. If DLQ publication fails, the source event remains unresolved and therefore replayable.

This prevents one poison event from permanently blocking a partition while preserving the original payload for operator or automated replay.

## Batching position

OS4 does not reintroduce forced refresh. OpenSearch's normal refresh lifecycle remains active.

The historical Redpanda Connect sink used 500-document / 10-second bulk batches. That is useful evidence, but OS4 does not copy the number blindly into the canonical writer because `PublicContentIndexWriter` performs alias/dedup and merge reads whose ordering semantics must be preserved.

The OS4 benchmark should therefore compare bounded canonical micro-batch strategies only after replay/backpressure correctness is green. Any bulk implementation must preserve:

1. per-document dedup/merge correctness;
2. partition order where the same content can appear repeatedly;
3. tombstone ordering;
4. alias-cache consistency;
5. offset resolution only after the corresponding OpenSearch side effect succeeds.

The selected batch/flush parameters become production inputs to OS5 resource/topology benchmarking; they are not guessed in this hardening slice.

## Validation invariants

This OS4 hardening slice is not mergeable unless CI proves:

- Fast Checks remain green;
- AP interop remains green;
- the OpenSearch 3.8 live compatibility lane remains green;
- KafkaJS batch auto-resolution is disabled;
- backpressure calls the actual KafkaJS resume callback;
- completion markers are recorded only after successful projection and before source-offset resolution;
- transient projection failure records no completion marker and resolves no offset;
- poison-event DLQ publication precedes offset resolution;
- DLQ publication failure leaves the source offset unresolved;
- the default DLQ is the already-governed `ap.firehose.dlq.v1` topic;
- the duplicate Redpanda Connect firehose sink is absent from the active streams directory;
- archived pipeline evidence is not loaded by the active streams glob;
- auxiliary Redpanda Connect OpenSearch uses the same 3.8 server generation as the canonical deployment.

## Deferred to later phases

OS5 owns minimum-resource/topology measurement. OS6 owns stored-field codec/level measurement. OS7 owns `_source`/derived-source storage work. OS8 owns shard/replica/rollover/retention/snapshot policy. The remaining OS4 batching/throughput measurement must preserve the replay invariants above and does not pre-empt those later phases.
