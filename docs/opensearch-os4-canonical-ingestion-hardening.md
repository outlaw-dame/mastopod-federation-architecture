# OS4 — Canonical ingestion, replay and backpressure hardening

Status: implementation / validation
Base: OS3 merge `3e941cc829b6dd4f22e3f3c172f13d60db533a4b`

## Canonical ingestion decision

OS4 designates `SearchIndexerService` as the sole canonical Redpanda -> Tier-3 public search projection for `ap.firehose.v1` and `ap.tombstones.v1`.

The historical Redpanda Connect `ap.firehose.v1 -> ap-activities` pipeline is removed from the active `redpanda-connect/streams/*.yaml` set and retained under `redpanda-connect/archive/` only as migration evidence. Running both paths created different public-search schemas and independent consumer groups, so they could not be treated as one coherent projection.

Redpanda Connect remains available for auxiliary pipelines whose responsibilities do not duplicate `public-content-v1` / `public-author-v1`.

## Reliability changes

### Real KafkaJS pause/resume

Before OS4, `SearchIndexerService` called the KafkaJS `pause()` callback but discarded its returned `resume()` function. Clearing an internal Boolean did not resume a paused consumer.

OS4 stores that callback and invokes it after the bounded retry delay. Partition processing therefore resumes after transient OpenSearch failures.

### Dedupe claim rollback

The search consumer claims local `outboxIntentId` values before projecting them. Previously, if the downstream projection failed, the Kafka offset remained unresolved but the dedupe claim survived. A retry could then be skipped as an already-processed duplicate.

`OutboxIntentDeduper.release()` now allows the consumer to undo a claim when the side effect fails. Redis-backed release uses `DEL`; a configured shared store that cannot release fails closed instead of silently accepting possible projection loss.

### Bounded poison-message retries and DLQ

Search projection retries are now bounded by `SEARCH_INDEXER_MAX_PROCESSING_ATTEMPTS` (default 5). An event that exhausts the limit is written unchanged to `SEARCH_INDEXER_DLQ_TOPIC` (default `ap.search-indexer.dlq.v1`) with headers recording:

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

The selected batch/flush parameters become production inputs to OS5 resource/topology benchmarking; they are not guessed in this phase.

## Validation invariants

OS4 is not complete unless CI proves:

- Fast Checks remain green;
- AP interop remains green;
- the canonical search indexer defaults to bounded retry + DLQ settings;
- backpressure calls the actual KafkaJS resume callback;
- dedupe release works in memory and through shared-store `DEL` semantics;
- the duplicate Redpanda Connect firehose sink is absent from the active streams directory;
- archived pipeline evidence is not loaded by the active streams glob;
- auxiliary Redpanda Connect OpenSearch uses the same 3.8 server generation as the canonical deployment.

## Deferred to later phases

OS5 owns minimum-resource/topology measurement. OS6 owns stored-field codec/level measurement. OS7 owns `_source`/derived-source storage work. OS8 owns shard/replica/rollover/retention/snapshot policy. OS4 does not pre-empt those measurements.
