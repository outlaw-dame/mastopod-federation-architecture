# Redis 8.2 acknowledged work-queue retention: guarded rollout

## Current status

The Fedify sidecar's legacy Redis 7 writer uses approximate
`XADD MAXLEN ~` trimming, which can delete queued work before it has been
read or acknowledged. Real Redis 7.4.12 and Redis 8.2.11 proofs in #148
established this difference directly.

This implementation adds an **opt-in** mode:
`REDIS_STREAM_ACKED_RETENTION=true`. It requires Redis 8.2+ and must remain
**disabled** on production Redis 7 or before the coordinated deployment gate.
When enabled:

- Each main work stream uses atomic `XTRIM MAXLEN = ... ACKED` reclamation
  followed by `XLEN` admission inside the same Lua script. A rejected
  append returns `REDIS_STREAM_AT_CAPACITY`. A batch never writes new
  entries when the precondition fails, and pending/unread messages are not
  sacrificed to meet the bound.
- The regular inbound, outbound, outbox-intent and origin-reconciliation
  enqueue paths share this contract. Outbound batch fanout has a matching
  atomic preflight, including its existing idempotent intent-state marker.
- Delayed outbound and outbox-intent promotion scripts check target stream
  capacity **before** deleting their delayed source. Rejected promotion
  must leave its schedule and payload intact for a later retry.
- DLQs are hard-capped and never automatically trim entries that have not
  undergone operator review. Failure to save a dead letter is an error;
  the original source must remain pending and must not be acknowledged.
- A Redis 7 endpoint with the opt-in flag fails the server-version gate
  instead of executing Redis 8.2-only commands.

## Zero-loss rollout and rollback

1. Inventory **all writers** to every queue key, including the main
   sidecar, delayed schedulers, fanout scripts, independent media services
   and scripts. No legacy `MAXLEN` writer may remain active while using
   ACKED retention; one old writer can still delete pending work.
2. Record the actual Redis server build, ACL, persistence policy, memory
   limit, eviction policy, replica lag, `XLEN`, `XPENDING` and consumer-group
   status. Back up the dataset and test a disposable restore. Use a
   supported Redis 8.2+ endpoint in a private, non-evicting authority/queue
   domain. Configure the deployment's rollback image/version in advance.
3. Quiesce old producers and drain all in-flight jobs. Preserve pending
   deliveries and delayed ZSET/hash records. Upgrade with an established
   backup and tested recovery plan. Do not deploy a mixed-version fleet
   where old producers continue trimming shared streams.
4. Set `REDIS_STREAM_ACKED_RETENTION=true` in **every** sidecar and delayed
   scheduler sharing the affected queues. Run the real Redis 8.2 proof
   workflow and exact-head federation/queue CI first. Restart workers
   under the new mode and validate acknowledgments, replay, backpressure,
   delayed promotion, DLQ and the absence of unexpected source ACKs.
5. Treat `REDIS_STREAM_AT_CAPACITY` as backpressure: return a retryable
   response to synchronous producers; for durable async producers retain
   original pending work and retry using bounded exponential backoff with
   jitter. Alert before capacity is reached. Never busy-loop, delete
   unacknowledged entries or ACK before a successful replacement write.
6. Record p50/p95/p99, RSS, actual `MEMORY USAGE`, queue byte rate,
   oldest pending age, `XLEN`, `XINFO GROUPS` lag, `XAUTOCLAIM` churn,
   DLQ growth, retained delayed payloads, and rejected/admitted events
   under 1/2/4 worker/broker-failure workloads.
7. Rollback requires quiescing new producers and preserving queue data;
   never downgrade a Redis 8.2 store to Redis 7 and restore legacy
   `MAXLEN` writers without a deliberate durable migration. An
   application-only rollback must not silently bypass ACKED retention.

## Performance and cost boundaries

`MAX_STREAM_LENGTH` is an **entry-count** budget, not a byte budget.
The example 500,000 entries can be prohibitively expensive if large AP
activities accumulate. Size it from observed message payload percentiles,
AOF/replica overhead, peak backlog and retention expectations. Use
`maxmemory-policy noeviction` for protected work, monitor available
headroom, and backpressure before memory pressure causes Redis write
failures. Redis 8.2 `ACKED` can retain more work than a desired
`MAXLEN`; this is why the explicit atomic admission check exists.

Because delayed scripts touch several independent Redis keys, current
queue admission assumes a **single Redis primary**, not arbitrary
multi-shard Redis Cluster. Do not claim Cluster compatibility from the
separate Sync source-fence hash-tag fix. Prove cross-slot layout and
cluster-aware clients before any queue Cluster rollout.

The on-by-default behavior stays legacy during development. The new
safety mode is deployable only after these acceptance gates pass. Keep
P0 #144 open until measured deployment proof, all writers, failure
recovery and automatic retry/backpressure are verified.

References:
- https://redis.io/docs/latest/commands/xadd/
- https://redis.io/docs/latest/commands/xtrim/
- https://redis.io/docs/latest/commands/xautoclaim/
- https://redis.io/docs/latest/commands/xinfo-groups/
- https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/
