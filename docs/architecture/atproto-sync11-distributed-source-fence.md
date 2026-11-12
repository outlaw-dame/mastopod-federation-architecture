# Verified Sync v1.1: distributed source ownership

The external `subscribeRepos` consumer now uses **one Redis-owned source
lease per canonical upstream source ID**. Each active lease has an epoch and
unpredictable owner token, a 15-second TTL, and periodic renewal. Only its
owner may record broker-acknowledged cursor progress or commit a checkpoint.

Other sidecars connected to the same Redis authority remain idle source
standbys while continuing their independent broker-consumer responsibilities.
They retry acquisition when the owner releases or its lease expires. Redis
unavailability, failed renewal, or a stale owner token terminates the source
socket rather than allowing optimistic publishing.

Cursor writes use atomic owner checks and monotonic comparisons on canonical
decimal integers. Replayed events at or below an acknowledged hot cursor are
allowed **without lowering it**; a committed checkpoint cannot move beyond
the hot acknowledged watermark. A former owner cannot release or mutate a
successor's lease.

The lease covers external Sync ingest only. It does not disable local
Paper/PDS firehose publication, and it does not turn unsigned Jetstream into
trusted ingestion.

## Important limitations

- A broker message can be accepted immediately before the source lease
  expires. If the owner then loses the right to advance its cursor, replay
  can produce a duplicate raw event. Exactly-once processing is **not**
  established by leases; durable downstream deduplication and per-DID
  ordering remain required.
- Redis Lua atomicity applies to a single primary, not to divergent Redis
  clusters, lost asynchronous replication data, or a forked external
  deployment. Use one managed Redis authority with verified persistence
  and recovery. No benchmark or source lease can substitute for validating
  the production Redis failover mode.
- The process-local source selector does not yet prevent a separate
  deployment from choosing unsigned Jetstream. A shared fleet-wide
  ingestion-mode admission fence and deployment ACL proof remain required.
- A standby reports that it is participating in the ingest runtime; it
  must not report itself as the socket-owning leader. Deployment health
  dashboards should distinguish an active source lease from standby.
- Required remaining tests: real broker outage/replay, crash and partition
  across 1/2/4 replicas, source leadership turnover, committed cursor
  retention after Redis restart/failover, downstream idempotency and
  p95/p99/RSS/CPU/cost under representative load.

See `docs/architecture/atproto-primary-sync-ingestion.md`,
`docs/architecture/atproto-sync11-firehose-ordered-ingest.md` and
the external Sync production acceptance issue.
