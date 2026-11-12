# Redis Streams queue retention: reproducible Redis 7 vs Redis 8.2 proof

The sidecar's worker queues currently use approximate `XADD MAXLEN ~`
trimming. Redis 7 does not protect an entry merely because the worker has
not yet acknowledged it. A deleted entry may still have a reference in
its consumer group's PEL, but the payload is no longer recoverable.

The isolated `redis-stream-pending-retention-proof.yml` workflow
creates a unique stream, delivers one entry without acknowledging it,
then appends 256 unread entries under heavy trimming pressure.

- Redis 7 fixture: proves that both an already-pending and an
  never-delivered entry may be removed by legacy approximate trimming.
- Redis 8.2.11 fixture: uses `XADD ... ACKED MAXLEN ~ 10` and requires
  both entries to survive. It subsequently delivers and acknowledges all
  records, invokes `XTRIM ... ACKED` and proves Redis can reclaim them.
- Both jobs record the actual server version, pending count, stream
  length and structured evidence. No real queues or production data are
  modified.

**This is a characterization proof, not a deployable retention fix.**
A durable work queue needs **both** acknowledgement-aware retention and
bounded ingress/backpressure. Redis 8.2's `ACKED` policy can retain
more than the target `MAXLEN` when consumers are stalled; silently
trimming unacked work to meet a RAM cap is not acceptable. The migration
must cover every enqueue path, including the outbound fanout Lua script,
and must prove restart/retry/DLQ behavior. Track in issue #144.

References:
- https://redis.io/docs/latest/develop/data-types/streams/
- https://redis.io/docs/latest/commands/xtrim/
- https://redis.io/docs/latest/commands/xautoclaim/
- https://redis.io/docs/latest/operate/oss_and_stack/install/version-mgmt/
