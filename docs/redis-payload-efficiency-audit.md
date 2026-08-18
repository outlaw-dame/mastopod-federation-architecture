# Redis payload efficiency audit

Status: evidence-only investigation. No production Redis Stream schema, ActivityPub authority, retry semantics, or payload lifetime has been changed.

## Why this exists

The APDM pre-`createJob` benchmark showed that eliminating the temporary SemApps `remotePost` capture shape saves far less wall time than expected, even at very high recipient counts. That shifts attention from short-lived JavaScript allocation to the durable data path, where immutable Activity bytes may be retained multiple times across ActivityPods Bull and the sidecar Redis Streams.

## Current durable path

```text
ActivityPods Delivery Plan
  └─ Bull deliveryHandoff job
       └─ HTTP handoff
            └─ sidecar outbox_intent Stream entry
                 ├─ activity: full immutable JSON
                 └─ targets: full target vector
                      ↓ normalize + shared-inbox dedupe
                 outbound Stream
                   ├─ endpoint job 1: full activity JSON
                   ├─ endpoint job 2: full activity JSON
                   └─ ... one job per unique delivery endpoint
```

Important details:

- ActivityPods persists `{ deliveryPlan }` in the Bull `deliveryHandoff` job. The plan contains the full Activity plus the full local/remote recipient vectors.
- The sidecar persists the Activity once more in the `outbox_intent` Stream and persists the entire normalized target vector as JSON.
- `OutboxIntentWorker` collapses targets by exact `sharedInboxUrl ?? inboxUrl` before creating outbound jobs.
- Every resulting outbound job currently carries the full immutable Activity string again.
- `XACK` acknowledges work for the consumer group but does not delete the Stream entry. The entry remains until trimming.
- The ActivityPods handoff queue is configured with completed-job age retention, so the handoff representation can coexist with sidecar Stream representations.
- Delayed retry stores can temporarily retain an additional serialized representation while the acknowledged historical Stream entry remains until trimming.
- Existing delayed outbound storage and DLQ storage serialize complete jobs/intents through JSON. Any production compression envelope therefore has to survive JSON round trips, not merely Redis binary strings.

Therefore **raw recipient count is not the outbound Activity-copy count**. For a sidecar intent with `E` unique delivery endpoints:

- sidecar durable Activity representations ≈ `1 + E`;
- including the ActivityPods Bull handoff representation ≈ `2 + E`;
- the target vector is additionally stored once in the handoff plan and once in the sidecar intent, with slightly different wire shapes.

Examples for 10,000 recipients:

| Unique delivery endpoints | Shared-inbox collapse | Sidecar Activity copies | Including Bull handoff |
|---:|---:|---:|---:|
| 10 | 1,000:1 | 11 | 12 |
| 100 | 100:1 | 101 | 102 |
| 10,000 | 1:1 | 10,001 | 10,002 |

The current atomic sidecar fan-out also sends every serialized outbound job to Redis as Lua `ARGV`. Because each job currently contains the Activity, this creates a **transient client/wire/parser amplification** proportional to unique delivery endpoints even though it is not a second persistent Redis copy.

## Candidate layouts under test

The benchmark deliberately does not mutate production code. It writes isolated benchmark keys and compares four storage layouts:

### A — current

- outbox intent carries plain Activity JSON and target JSON;
- each outbound endpoint job carries plain Activity JSON.

### B — compression only

- large opaque Activity/target fields are Zstd-compressed;
- queue-carried compressed bytes are encoded as **base64url strings** so they remain JSON-safe through the existing delayed retry and DLQ serializers;
- routing/state fields remain directly readable;
- the identical encoded Activity is computed once and reused for all endpoint writes.

The base64url envelope deliberately pays its roughly 4/3 byte expansion over raw compressed bytes. This makes B a more realistic estimate for a minimally invasive production schema than writing raw Redis binary fields which would require redesigning every JSON durability boundary.

This variant retains self-contained outbound jobs and therefore preserves the strongest crash/replay independence of the current design.

### C — canonical payload + references

- Activity stored once in a dedicated payload key;
- outbox and outbound records carry a content-addressed reference;
- target vector remains inline.

This tests deduplication upside but is **not production-safe by itself**. A production reference design must prove payload retention, cleanup, missing-payload failure behavior, crash recovery, delayed retry lifetime, DLQ lifetime, and multi-worker cache behavior.

### D — canonical compressed payload + references

- Activity stored once as compressed binary in the dedicated payload key;
- records carry the content-addressed reference plus encoding metadata;
- queue-carried compressed target bytes use the same JSON-safe base64url envelope as B.

The dedicated canonical payload itself does not flow through the delayed/DLQ JSON serializers, so its benchmark representation can remain binary. This estimates the maximum combined memory/wire benefit while keeping the same referential-integrity warning as C.

## Compression codec evidence

The benchmark compares Gzip level 6, Brotli quality 4, and Zstd level 3 for each deterministic Activity payload size. It records both raw compressed bytes and the base64url queue-envelope size plus p50/p95 encode/decode time. Production queue decisions must use the **queue-envelope ratio**, not the more favorable raw compression ratio.

Node's built-in Zstd API is available only from Node 22.15 and is still marked experimental. The sidecar package currently supports Node >=20. Therefore **this benchmark does not imply that built-in Node Zstd is an acceptable production dependency**. If Zstd wins materially, production options still require a separate compatibility decision: raise the supported Node floor, use a maintained stable Zstd implementation, or choose a stable built-in codec such as Brotli/Gzip if its whole-system tradeoff is better.

The evidence script uses synchronous codec calls only to make isolated codec measurements deterministic. A production hot path must not simply copy that implementation: synchronous compression can block the event loop, while asynchronous compression can contend for the runtime worker pool. Whole-system queue latency and CPU must be measured before promotion.

## Evidence matrix

The script produces two evidence layers.

### Theoretical matrix

For Activity sizes around 2 KiB, 20 KiB, and 100 KiB and recipient counts `1, 10, 100, 1000, 10000`, calculate:

- target-vector JSON bytes;
- unique delivery endpoint counts for high-, medium-, and zero-collapse cases;
- current Activity copy count and logical bytes;
- cross-Redis copy count including the ActivityPods Bull handoff.

### Real Redis matrix

For bounded high-value scenarios, write the four variants to a real Redis instance and record:

- `MEMORY USAGE ... SAMPLES 0` for every benchmark key;
- total Redis bytes for the layout;
- logical field bytes before Redis allocator/data-structure overhead;
- bounded write elapsed time;
- reduction ratios versus current.

The write-time figure is intentionally only an **equivalent-field MULTI/XADD envelope measurement**. The production `enqueueOutboundBatchForIntent` uses a Lua fan-out transaction, so these write times may indicate byte-amplification direction but are not production fan-out latency claims.

A safety cap skips combinations whose current logical layout would exceed the benchmark's bounded memory budget.

## Repeated real-Redis evidence

Accepted exact head: `16c6f6e7a7fe3e97f25550c36106fff576db5ca0`.

The same workflow/job was executed twice against Redis 7.4.10 with default Stream macro-node settings (`stream-node-max-bytes=4096`, `stream-node-max-entries=100`). Both attempts completed the benchmark, schema validation, Redis-runtime capture and artifact upload successfully.

- run `32127608890`, attempt 1 artifact `redis-payload-efficiency-32127608890-1`, digest `sha256:0c5144f3604b2c834c42f64e16ca84db29a2fbc35bc3e1f638bf67aaec766df0`;
- run `32127608890`, attempt 2 artifact `redis-payload-efficiency-32127608890-2`, digest `sha256:c63e88aee26bf4d4e88c9eb42537702b246047648c32decf1c4518bb3bfa06b4`.

Across matched layout points, Redis `MEMORY USAGE` reproduced to within approximately **0.0024%**. CI write timings varied materially and remain directional only, as documented above.

### Selected memory results

Values are total measured Redis bytes for the isolated equivalent layout. Reduction is versus A/current.

| Activity | Recipients | Unique endpoints | A current | B compressed/self-contained | C reference | D reference+compressed |
|---:|---:|---:|---:|---:|---:|---:|
| 2 KiB | 10,000 | 10 | 2.13 MB | 45.7 KB (**46.5×**) | 2.11 MB (1.01×) | 31.3 KB (68.0×) |
| 2 KiB | 10,000 | 100 | 2.38 MB | 218.7 KB (**10.9×**) | 2.14 MB (1.11×) | 70.8 KB (33.7×) |
| 2 KiB | 10,000 | 10,000 | 30.06 MB | 19.32 MB (**1.56×**) | 6.22 MB (4.84×) | 4.46 MB (6.74×) |
| 20 KiB | 10,000 | 10 | 2.35 MB | 139.2 KB (**16.9×**) | 2.13 MB (1.10×) | 37.5 KB (62.6×) |
| 20 KiB | 10,000 | 100 | 4.58 MB | 1.08 MB (**4.23×**) | 2.17 MB (2.11×) | 76.9 KB (59.6×) |
| 20 KiB | 1,000 | 1,000 | 25.04 MB | 10.52 MB (**2.38×**) | 627.5 KB (39.9×) | 454.5 KB (55.1×) |
| 100 KiB | 10,000 | 10 | 3.25 MB | 577.5 KB (**5.62×**) | 2.22 MB (1.46×) | 71.3 KB (45.6×) |
| 100 KiB | 10,000 | 100 | 13.59 MB | 5.02 MB (**2.71×**) | 2.26 MB (6.02×) | 110.7 KB (122.8×) |
| 100 KiB | 1,000 | 1,000 | 115.28 MB | 49.47 MB (**2.33×**) | 717.6 KB (160.6×) | 488.3 KB (236.1×) |

The 20 KiB/10,000-endpoint and 100 KiB/10,000-endpoint real writes were intentionally skipped by the 160 MiB safety cap. Their theoretical current Activity bytes alone are approximately 204.8 MB and 1.024 GB respectively before Redis data-structure overhead.

### What the results mean

Two distinct amplification regimes exist:

1. **High shared-inbox collapse / low endpoint count:** the full target vector dominates. Reference-only storage barely helps, while compressing the target vector produces very large savings. This is why B beats C strongly at 10,000 recipients / 10 endpoints.
2. **Low collapse / high endpoint count:** repeated outbound Activity bodies dominate. References produce enormous savings because they remove one immutable Activity copy per endpoint. Compression-only remains material, but cannot match deduplication at high endpoint cardinality.

The codec evidence also remained stable across runs. With the JSON-safe base64url queue envelope, the deterministic 20 KiB Activity compressed approximately 2.26× with Zstd-3 versus 2.09× with Brotli-4; at 100 KiB the figures were approximately 2.20× versus 2.03×. Zstd was faster in these isolated synchronous measurements, but its incremental compression gain over Brotli is single-digit percentage territory while its current built-in Node API would require Node >=22.15 and remains experimental.

## Promotion decision from this slice

**Promote compression-only to a feature-gated production prototype. Do not promote canonical references yet.**

Rationale:

- B produced a material Redis-memory reduction at every measured point, including after the JSON-safe base64url overhead;
- B preserves self-contained queue jobs and therefore does not create a new payload-lifetime dependency;
- the largest low-endpoint gains come from target-vector compression, which references alone do not address;
- C/D prove that canonical references may be valuable later, especially at high endpoint cardinality, but their durability/cleanup contract is a separate architectural change and must not be smuggled in as a memory optimization;
- built-in experimental Zstd is not promoted as the production codec. A first prototype should prefer a stable Node-20-compatible built-in codec (Brotli is the leading candidate from this evidence) and remain disabled by default until whole-system latency/CPU/failure evidence closes its gate.

The production prototype should decode the compressed envelope unconditionally for rolling-upgrade compatibility while enabling writes only behind an explicit feature flag. Compression should be applied at Redis Stream serialization boundaries so in-memory `OutboxIntent`/`OutboundJob`, delayed retry JSON and DLQ JSON remain backward-compatible. Large payloads should be compressed once and reused across a fan-out batch rather than recompressed per endpoint.

## Promotion rules

No storage-format change should be promoted from compression ratio alone.

Compression-only is eligible for a production prototype only if repeated evidence shows a material reduction in Redis memory and/or wire bytes while encode/decode CPU and queue latency remain within the frozen ADSP regression limits.

Any production decompressor must also fail closed on unknown encodings, enforce compressed and decompressed size ceilings, and verify round-trip/digest integrity where a content-addressed identity is used. A smaller payload is not worth adding an unbounded decompression or corruption failure mode.

Reference-based storage has an additional gate: the canonical payload must be at least as durable and replay-safe as today's self-contained job bytes. A reference design that saves memory but can strand an outbound job after payload expiry, eviction, trim, worker crash, delayed retry, or DLQ replay is rejected.

The benchmark is intentionally independent of NATS and JetStream. Its purpose is to determine how far the incumbent Redis architecture can be made more efficient before adding another runtime.
