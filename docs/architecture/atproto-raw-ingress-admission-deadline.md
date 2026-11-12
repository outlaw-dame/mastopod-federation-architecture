# Raw ATProto ingress admission and Redis operation deadlines

The external raw Redpanda topic is **not** a trusted repository feed.
Before spending Redis memory or performing cryptographic verification, the
consumer now requires an envelope from one of the explicitly configured
upstream source URLs. Unknown sources, malformed event shapes, invalid
sequence numbers, `#info` controls, oversized JSON envelopes and poison
JSON are dropped without promoting them to trusted ingress. Drops must be
observed via the consumer's warning/metrics path, not silently requeued
forever to stall the partition.

Redis source-ownership and fleet-mode operations have bounded deadlines
derived from the lease TTL (200–4000 ms). A hung command triggers ownership
loss and disconnect or fleet-mode shutdown. Redis Lua checks continue to
fence any delayed command that completes after the timeout.

These controls protect bounded memory and stream availability; they do not
establish exactly-once cross-store transactions. A raw message accepted by
Redpanda immediately before a lease expiry may be replayed after takeover.
Verified consumers must remain idempotent.

Release gates still require production-equivalent Redis persistence/failover,
1/2/4-worker broker replay, p95/p99 throughput and heap measurements, and
the separate ActivityPods canonical SAI/PostgreSQL credential proof.
