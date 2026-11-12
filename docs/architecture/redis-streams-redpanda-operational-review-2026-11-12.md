# Redis, Redis Streams, and Redpanda: operational correctness and cost review

**Review date:** 2026-11-12
**Applies to:** Paper/ActivityPods Fedify sidecar, external verified ATProto Sync and AP delivery queues.
**Purpose:** Source-verified deployment review, not a claim of production load acceptance.

## Verified implementation baseline

- The verified external Sync consumer now uses source-specific Redis leases and
  owner-fenced hot/committed cursors. PRs #137–#143 added bounded sockets, a
  shared Sync-vs-Jetstream mode guard, Cluster-compatible v2 Redis hash tags,
  legacy-checkpoint migration safety, replay suppression and operation timeouts.
- PR #142 corrected the previous mismatch between a 5 MiB CBOR frame, its
  ~6.7 MiB Base64 JSON envelope and ordinary broker limits. The raw-only
  limits are 8 MiB serialized publisher event, 9 MiB topic, 10 MiB partition
  fetch and 16 MiB consumer total fetch. A real disposable Redpanda broker
  received and verified 6,990,712 serialized bytes from a 5,242,880-byte
  synthetic frame. This is **not** a cryptographic Sync verification proof.
- Queue paths in `src/queue/sidecar-redis-queue-core.ts` currently use
  Redis Streams, `XREADGROUP`, `XAUTOCLAIM`, `XACK` and approximate
  `XADD MAXLEN ~` for multiple work streams. Redis 7 is used by the
  existing fast-check CI and local compose fixtures. The queue retention
  semantics under delayed acknowledgment remain a **P0 release blocker**
  (issue #144).
- KafkaJS `producer.send` uses `acks=-1` by default; **KafkaJS
  `producer({idempotent:...})` defaults to false**, and enabling idempotence
  has its own client-side retry and inflight trade-offs. A successful broker
  acknowledgment by itself is not end-to-end exactly-once delivery.
- Several older docker-compose and CI fixtures use EOL Redpanda 24.1
  images. A supported 26.2.6 broker is being validated in a separate
  disposable CI lane; no production broker upgrade has been made.

## Redis authority, security and availability

**Deployment principle:** protect source leases, cursors, queues, identity
and consent proof as *non-evictable* state. A cache eviction must never
silently become a lost source lease, revoked grant, group membership proof
or missing Redis Streams entry. Prefer `maxmemory-policy noeviction` for
the protected workload; when exhausted, reject/backpressure writers and
alert instead of dropping protected keys. Cache TTL/LRU data may be isolated
when needed. Logical key/ACL isolation is cheap; separate physical Redis
only if latency, eviction policy or failure-domain measurements warrant it.

- **Redis Cluster:** Lua multi-key commands require a common hash slot;
  the new external Sync v2 `{source-hash}` tag satisfies this for the
  source-fencing group. The runtime still uses the normal `Redis` client,
  so moving to multi-node Cluster requires a separate cluster-aware client
  and migration acceptance. The v1 namespace must be drained/migrated:
  `docs/architecture/atproto-redis-cluster-lease-v2-rollout.md`.
- **Durability:** default AOF `appendfsync everysec` is a useful cost/latency
  compromise but may lose approximately a second of data on a disaster.
  RDB alone is not appropriate as the only protection for live canonical
  checkpoints, leases or queued work. AOF and replica acknowledgments
  must be tested during actual failover. `WAIT` and `WAITAOF` improve
  awareness of replication/fsync but do **not** make Redis a consensus
  database or a substitute for canonical Postgres authority.
- **Connections:** maintain long-lived redis clients; dedicate blocking
  `XREADGROUP` connections so one waiting queue cannot hold up unrelated
  command traffic. Avoid polling `KEYS`, account-wide scans and frequent
  reconnects. A bounded pipeline is useful only for independent commands;
  a lease's read/modify/write requires one atomic Lua check.
- **Security:** private network, TLS where crossing trust boundaries,
  per-service ACLs, scoped key prefixes, no administrative commands in
  application credentials, no public port exposure. Lua-capable clients
  must be the exact trusted internal services and their Redis version
  must include security fixes.
- **Instrument:** `INFO memory` (`used_memory`, `mem_fragmentation_ratio`,
  `evicted_keys`), `INFO persistence` (AOF errors/rewrites/forks),
  `INFO replication`, connection counts, `SLOWLOG GET`,
  `LATENCY LATEST`, source lease churn, hot-vs-committed cursor gaps and
  fence RPC p95/p99. Never call observed CI loopback values production SLA.

## Redis Streams: correctness before aggressive trimming

The current `MAXLEN ~` strategy is efficient because it trims whole
stream macro-nodes, but **on Redis 7 it does not protect pending or
undelivered queue work**. A Redis Streams `XACK` removes the PEL reference,
not necessarily the stream entry. Redis 8.2 added `ACKED` trimming for
`XADD` / `XTRIM`, which only removes entries acknowledged by all
consumer groups. This is the preferred direction for true work queues,
with the following non-negotiable conditions:

1. Prove the actual Redis server and client support `ACKED` semantics,
   first in an isolated Redis 8.2+ test and with legacy Redis 7 behavior
   explicitly understood. Do not add 8.2 syntax to a Redis 7 deployment.
2. Migrate **all** main queue producer paths and outbound fanout Lua
   consistently; otherwise a single old path can still delete work.
   Confirm the intended group cardinality and keep data until *all*
   relevant consumers have acknowledged.
3. `ACKED` may retain more entries than `MAXLEN` if slow consumers
   remain pending. Add a bounded producer admission/backpressure budget
   and alerts rather than silently dropping work. Prove restarts, retries,
   failed acknowledgments, DLQ, idempotency and long-running deliveries.
4. `XAUTOCLAIM` scans up to 10× the requested `COUNT`, returns a
   continuation cursor, and increments retry counts. Avoid a single
   unbounded pending-list scan. Use sensible min-idle thresholds above
   normal processing time, and detect poisoned work through delivery
   attempts and oldest pending age. The current implementation often
   restarts scans at `0-0`; instrument full-cycle scans before changing
   their scheduling behavior.
5. `XINFO GROUPS` lag, `XPENDING` count/oldest age, `XLEN`, `XINFO
   CONSUMERS`, DLQ length and stream memory are useful signals.
   Scale consumers to workloads only after fixing admission, recovery
   and stream retention. A single Redis Stream **key** is not automatically
   sharded by adding consumers.

**Open gate:** issue #144. Do not claim lossless worker queues while it is
open.

## Redpanda: data durability, operations and cost

- **Supported version:** v24.1 is EOL. Prefer current supported patched
  versions (v26.2.6 verified available as of this review) for new
  performance/compatibility testing, using a pinned image for reproducible
  CI. Do not silently upgrade production; follow Redpanda's supported
  rolling-upgrade path.
- **Ack and dedupe:** keep replication policy and `acks=-1` on durable
  work paths. Test `min.insync.replicas` and producer failure under
  broker loss. KafkaJS idempotence is **off by default** and described
  as experimental; test targeted enablement and transaction support
  before changing all publishers. Idempotent producer sessions still
  cannot prevent duplicates caused by an application restarting and
  deliberately replaying from the Redis checkpoint.
- **Partitioning:** maintain a stable repository DID or logical aggregate
  partition key for per-repository ordering; do not assume ordering
  across unrelated partitions. Measure rebalance and consumer lag after
  switching between 1, 2 and 4 workers.
- **Compression:** use Zstd where the established benchmark wins on
  *real* CBOR/JSON/AP messages with representative sizes, taking into
  account CPU, throughput, egress and decompression limits. A 5 MiB
  maximum is a safety allowance, not the typical message size.
- **Retention:** raw external Sync currently retains three days.
  Estimate logical raw bytes from
  `observed_ingress_bytes_per_sec × 86,400 × retention_days`;
  multiply by replication factor for a rough broker disk floor before
  compression and overhead, then model tiered storage/object API/egress
  separately. Do not change retention until backfill/replay RPO and
  actual rate have been observed.
- **Tiered storage:** evaluate when measured cold retention dominates
  broker disk cost. It introduces object storage, read-amplification,
  API/egress costs and lifecycle constraints. Confirm licensing and
  feature availability for the chosen deployment; it is not automatically
  cheaper for small, short-lived work topics.
- **Operations:** monitor broker storage by topic/partition, request
  failures, throttling, producer/consumer p95/p99, retained byte rate,
  retry amplification, consumer offset lag, rebalance duration and
  compression ratio. Keep broker/topic ACLs separating
  `at.firehose.raw.*`, unverified Jetstream, and trusted `at.ingress.v1`.

## Release gates and controlled experiment

**P0 — correctness:** close issue #144, v1→v2 cursor migration where
needed, actual Redis configuration/ACL/replication verification, real
Redpanda ACL + replay tests, verified Sync rebuild and protected
ActivityPods SAI/Postgres authorization checks.

**P1 — throughput:** run identical 1/2/4 replica workloads with realistic
upstream traffic, real Redis/Redpanda, the actual verifier and larger
frames. Record p50/p95/p99, error rate, broker lag, CPU, RSS/heap,
Redis slowlog and reconnect/retry volume. Identify where single-source
serialized broker acknowledgments cap achievable throughput. Benchmark
the open-source Tap alternative against exactly the same workload
before replacing the current reader.

**P2 — cost:** size memory from observed stream cardinality and
payload distribution, not theoretical maximums. Keep cache eviction
and durable queue policy separate. Compare actual broker replication
disk use, compression ratio, object store/tiered storage options,
network transfer and operations overhead. Do not introduce extra
infrastructure solely because it sounds scalable.

## Primary references

1. Redis Streams: https://redis.io/docs/latest/develop/data-types/streams/
2. XAUTOCLAIM: https://redis.io/docs/latest/commands/xautoclaim/
3. XTRIM / ACKED: https://redis.io/docs/latest/commands/xtrim/
4. Redis Cluster slots: https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
5. Redis persistence: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/
6. Redis latency: https://redis.io/docs/latest/management/optimization/latency/
7. Redis ACLs: https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/
8. Redis version support: https://redis.io/docs/latest/operate/oss_and_stack/install/version-mgmt/
9. Redis pipeline: https://redis.io/docs/latest/develop/using-commands/pipelining/
10. Redpanda producer idempotence: https://docs.redpanda.com/streaming/current/develop/produce-data/idempotent-producers/
11. Redpanda topic properties: https://docs.redpanda.com/streaming/current/reference/properties/topic-properties/
12. Redpanda tiered storage: https://docs.redpanda.com/streaming/current/manage/tiered-storage/
13. Redpanda support schedule: https://support.redpanda.com/hc/en-us/articles/20617574366743-Redpanda-Supported-Versions
14. KafkaJS producers: https://kafka.js.org/docs/producing
15. KafkaJS consumers: https://kafka.js.org/docs/consuming
16. KafkaJS transactions: https://kafka.js.org/docs/transactions
