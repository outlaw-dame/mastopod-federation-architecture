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
- routing/state fields remain directly readable;
- the identical compressed Activity is computed once and reused for all endpoint writes.

This retains self-contained outbound jobs and therefore preserves the strongest crash/replay independence of the current design.

### C — canonical payload + references

- Activity stored once in a dedicated payload key;
- outbox and outbound records carry a content-addressed reference;
- target vector remains inline.

This tests deduplication upside but is **not production-safe by itself**. A production reference design must prove payload retention, cleanup, missing-payload failure behavior, crash recovery, delayed retry lifetime, DLQ lifetime, and multi-worker cache behavior.

### D — canonical compressed payload + references

- Activity stored once, compressed with Zstd;
- records carry the content-addressed reference;
- target vector is Zstd-compressed in the intent.

This estimates the maximum combined memory/wire benefit while keeping the same referential-integrity warning as C.

## Compression codec evidence

The benchmark also compares Gzip level 6, Brotli quality 4, and Zstd level 3 for each deterministic Activity payload size, recording compressed bytes and p50/p95 encode/decode time.

Node's built-in Zstd API is available only from Node 22.15 and is still marked experimental. The sidecar package currently supports Node >=20. Therefore **this benchmark does not imply that built-in Node Zstd is an acceptable production dependency**. If Zstd wins materially, production options still require a separate compatibility decision: raise the supported Node floor, use a maintained stable Zstd implementation, or choose a stable built-in codec such as Brotli/Gzip if its whole-system tradeoff is better.

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
- write elapsed time;
- reduction ratios versus current.

A safety cap skips combinations whose current logical layout would exceed the benchmark's bounded memory budget.

## Promotion rules

No storage-format change should be promoted from compression ratio alone.

Compression-only is eligible for a production prototype only if repeated evidence shows a material reduction in Redis memory and/or wire bytes while encode/decode CPU and queue latency remain within the frozen ADSP regression limits.

Reference-based storage has an additional gate: the canonical payload must be at least as durable and replay-safe as today's self-contained job bytes. A reference design that saves memory but can strand an outbound job after payload expiry, eviction, trim, worker crash, delayed retry, or DLQ replay is rejected.

The benchmark is intentionally independent of NATS and JetStream. Its purpose is to determine how far the incumbent Redis architecture can be made more efficient before adding another runtime.
