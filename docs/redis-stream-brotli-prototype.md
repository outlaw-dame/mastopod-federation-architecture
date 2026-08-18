# Redis Stream Brotli prototype

Status: feature-gated capability. **Compressed writes remain disabled by default.**

This prototype follows the payload-efficiency evidence merged in PR #89. It changes only the ready Redis Stream representation for the large opaque `activity` and outbox-intent `targets` fields. In-memory `OutboxIntent` / `OutboundJob` contracts, ActivityPub authority, job identity, delayed retry JSON, and DLQ JSON remain self-contained and unchanged.

## Rolling-upgrade contract

Readers always understand both plaintext and the versioned compressed envelope. Writers emit compressed fields only when `REDIS_STREAM_PAYLOAD_COMPRESSION_ENABLED=true` and the encoded envelope is actually smaller than plaintext.

The intended rollout order is therefore:

1. deploy decode-capable code everywhere with writes still disabled;
2. validate mixed plaintext/compressed replay and operational evidence;
3. enable compressed writes only as an explicit staged deployment action;
4. retain plaintext decoding indefinitely for rollback and retained Stream entries.

Merging this capability must not implicitly perform step 3.

## Envelope

Compressed fields use:

```text
apq1:br:<sha256-of-uncompressed-bytes>:<canonical-base64url-brotli-bytes>
```

The decoder fails closed on unknown versioned encodings, malformed digest/base64url data, Brotli failure, size-limit violations, or SHA-256 mismatch. Compressed and decompressed byte ceilings are enforced.

A bounded LRU decode cache is keyed by the **exact validated envelope string**, not merely the advertised content digest. This allows identical Activity bytes repeated across fan-out jobs to reuse the decoded value without letting changed compressed bytes inherit a previous validation. Cache byte accounting includes both the envelope key and decoded value.

Malformed ready-Stream entries are isolated per message: they are logged and left pending rather than ACKed, while later valid work in the same claimed/read batch continues. This prevents one corrupt retained entry from monopolizing the whole consumer iteration without weakening the durable-before-ACK contract.

## CPU-oriented codec settings

The prototype uses Node's built-in Brotli support at quality `0`, the speed-oriented mode.

The tuning sequence was evidence-driven:

- quality 4 materially reduced Redis memory but exceeded the frozen ADSP latency and CPU guards;
- quality 1 plus bounded decode reuse removed most of the regression and made high-endpoint fan-out substantially faster, but one p95 latency point and one CPU point still missed the frozen gates;
- quality 0 plus exact-envelope decode reuse cleared all frozen queue-path guards in two matched runs while retaining multi-fold memory savings.

Default compression threshold: 4 KiB.

## Environment controls

- `REDIS_STREAM_PAYLOAD_COMPRESSION_ENABLED` — writer gate; default `false`.
- `REDIS_STREAM_PAYLOAD_COMPRESSION_MIN_BYTES` — minimum plaintext size considered for compression; default 4096.
- `REDIS_STREAM_PAYLOAD_MAX_COMPRESSED_BYTES` — compressed input ceiling; default 16 MiB.
- `REDIS_STREAM_PAYLOAD_MAX_DECOMPRESSED_BYTES` — decompressed output ceiling; default 32 MiB.
- `REDIS_STREAM_PAYLOAD_BROTLI_QUALITY` — Brotli quality; prototype default 0.
- `REDIS_STREAM_PAYLOAD_DECODE_CACHE_MAX_BYTES` — bounded decoded-envelope cache budget; default 8 MiB.

## Evidence gates

The production-codec Redis proof must retain a material memory reduction. The paired real queue-path benchmark uses five measured samples per arm after one warmup and covers ready-Stream serialization, atomic fan-out, consumer-group read/decode, and ACK.

Frozen ADSP guards applied to this in-place optimization:

- p95 queue-path elapsed regression <= 10%;
- p99 queue-path elapsed regression <= 15%;
- process CPU/completed-work regression <= 15%;
- material memory benefit >= 10%;
- zero correctness, authority, retry, or replay drift.

The queue-path benchmark intentionally excludes remote HTTP delivery and ActivityPods upstream recipient planning. It is a promotion gate for this Redis representation only, not a claim about full federation end-to-end latency.

## Repeated quality-0 queue-path evidence

Accepted code/evidence head: `31ebae3fae7ea89d6fdae9c77779c41389390665`.

Workflow run `32135747143` was executed twice with Node `v20.20.2` and Redis 7:

- attempt 1 artifact `redis-stream-brotli-queue-path-32135747143-1`, digest `sha256:a6808acbae294d2229dfda2ed8213179ba99883decae781f6bb0f16222ea0374`;
- attempt 2 artifact `redis-stream-brotli-queue-path-32135747143-2`, digest `sha256:bb5c500326fae86e10d55ca59e68a661a76248fdd05705de41aae5b9681fbbf0`.

Both attempts passed all four frozen guards.

### Attempt 1

| Scenario | p95 elapsed ratio | p95 CPU ratio | Redis memory reduction |
|---|---:|---:|---:|
| 20 KiB Activity, 10k recipients / 10 endpoints | 0.936 | 0.999 | 13.59x |
| 100 KiB, 10k / 100 endpoints | 0.658 | 0.876 | 2.69x |
| 100 KiB, 1k / 1k endpoints | 0.684 | 0.846 | 2.33x |

Worst-case guard values: p95 elapsed `0.936`, p99 elapsed `0.936`, p95 CPU `0.999`, minimum memory reduction `2.33x`.

### Attempt 2

| Scenario | p95 elapsed ratio | p95 CPU ratio | Redis memory reduction |
|---|---:|---:|---:|
| 20 KiB Activity, 10k recipients / 10 endpoints | 0.970 | 1.001 | 13.59x |
| 100 KiB, 10k / 100 endpoints | 0.687 | 0.836 | 2.69x |
| 100 KiB, 1k / 1k endpoints | 0.749 | 0.863 | 2.33x |

Worst-case guard values: p95 elapsed `0.970`, p99 elapsed `0.970`, p95 CPU `1.001`, minimum memory reduction `2.33x`.

The repeated result is therefore not merely a storage win. On the tested Redis queue path the large fan-out cases become substantially faster and lower-CPU because fewer bytes cross Redis and identical compressed Activities are decoded once per bounded cache residence. The small-endpoint case remains effectively CPU-neutral while still reducing Redis memory by more than an order of magnitude.

The production-codec Redis proof on the same accepted head also completed successfully; artifact `redis-stream-brotli-32135747106-1`, digest `sha256:b94495de18d7ca01f05316d1e0ec4fbe55cf85fad1b602cedfc1884f7908ff7c`.

## Promotion decision

**The feature-gated Brotli capability is eligible to merge, but compressed writes remain disabled by default.**

The evidence supports a later staged writer enablement after decode-capable code is confirmed across the fleet. That operational switch is deliberately separate from merging this code so mixed-version deployment cannot strand retained compressed Stream work.

Canonical payload references remain out of scope. They still require a separate crash-safe retention and cleanup contract before they can be considered for production.
