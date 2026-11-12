# Disposable Redis source-fence performance baseline

The fast-check suite now records a repeatable, low-cost sample of the
**Redis Lua acknowledgment/checkpoint hot path** under 1, 2 and 4
concurrent Redis clients competing for one source lease. Exactly one
source owner must win at each worker count.

For each count the test performs 512 owner-fenced Redis acknowledgments,
one committed checkpoint every 64 events and lease renewal. It emits
machine-readable `SYNC_FENCE_BASELINE` JSON containing p50/p95/p99 Redis
acknowledgment latency, acknowledgments/second and process RSS delta.

This is intentionally **not** a production capacity measurement. It excludes:
- upstream network, TLS, real Sync v1.1 CBOR and signed-commit/MST verification;
- Redpanda broker acknowledgment, consumer partition assignment, DID resolution;
- sustained event bursts, large payloads, Redis persistence/failover;
- the cost of real 1/2/4 *active* repositories and SAI/PostgreSQL authorization.

Use this test only for regression screening. The production release issue
requires a separate matched whole-system workload with controlled arrivals,
recorded p95/p99, sustained heap/RSS, broker lag, retry amplification and
cost. Avoid using the measured CI operations/second as a production SLA.
