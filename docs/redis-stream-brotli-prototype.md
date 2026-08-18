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

## CPU-oriented codec settings

The prototype uses Node's built-in Brotli support and currently evaluates quality `0`, the speed-oriented mode. The earlier quality-4 queue-path run materially reduced Redis memory but exceeded the frozen ADSP latency/CPU guards. Quality 1 plus bounded decode reuse removed most of that regression and made high-endpoint fan-out substantially faster, but one latency point and one CPU point still missed the frozen gates. Quality 0 is therefore being measured against the exact same paired queue-path contract rather than being assumed better.

Default compression threshold: 4 KiB.

## Environment controls

- `REDIS_STREAM_PAYLOAD_COMPRESSION_ENABLED` — writer gate; default `false`.
- `REDIS_STREAM_PAYLOAD_COMPRESSION_MIN_BYTES` — minimum plaintext size considered for compression; default 4096.
- `REDIS_STREAM_PAYLOAD_MAX_COMPRESSED_BYTES` — compressed input ceiling; default 16 MiB.
- `REDIS_STREAM_PAYLOAD_MAX_DECOMPRESSED_BYTES` — decompressed output ceiling; default 32 MiB.
- `REDIS_STREAM_PAYLOAD_BROTLI_QUALITY` — Brotli quality; prototype default 0.
- `REDIS_STREAM_PAYLOAD_DECODE_CACHE_MAX_BYTES` — bounded decoded-envelope cache budget; default 8 MiB.

## Evidence gates

The production-codec Redis proof must retain a material memory reduction. The paired real queue-path benchmark uses at least five measured samples per arm after warmup and covers ready-Stream serialization, atomic fan-out, consumer-group read/decode, and ACK.

Frozen ADSP guards applied to this in-place optimization:

- p95 queue-path elapsed regression <= 10%;
- p99 queue-path elapsed regression <= 15%;
- process CPU/completed-work regression <= 15%;
- material memory benefit >= 10%;
- zero correctness, authority, retry, or replay drift.

The queue-path benchmark intentionally excludes remote HTTP delivery and ActivityPods upstream recipient planning. It is a promotion gate for this Redis representation only, not a claim about full federation end-to-end latency.

Canonical payload references remain out of scope. They still require a separate crash-safe retention and cleanup contract before they can be considered for production.
