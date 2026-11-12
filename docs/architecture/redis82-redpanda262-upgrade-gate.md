# Redis 8.2 and Redpanda 26.2 baseline and migration gate

## Baseline (2026-11-12)

- First-party Redis runtime and first-party CI default: **Redis 8.2.11**, supported extended-release series. This pin is distinct from third-party application Redis containers and the explicit Redis 7 loss-reproduction matrix.
- First-party Redpanda development/interop broker and benchmark default: **Redpanda v26.2.6**, currently supported release line. Image tags are fixed; production image digests must be resolved and pinned by the deployment manifest.
- **Runtime versions are not proof of feature activation.** The acknowledgment-aware Streams admission path is introduced separately in PR #150. Do not treat upgrading the Redis image as protection from legacy `XADD MAXLEN ~` writers. P0 #144 remains a deployment gate.

## Never directly upgrade an existing persisted Redpanda 24.x broker to 26.2

The Compose files describe a *new-installation baseline*, not an approved data migration.
Redpanda permits only supported feature-release upgrade paths and recommends rolling broker upgrades on live clusters. Upgrading an existing 24.x data directory directly to v26.2.6 is **not** an acceptable automated step. Preserve its volumes. Do not run `docker compose down -v` on persistent data.

1. Inventory every broker's exact version, node ID, persistent volume, topic partition configuration, consumer-group offsets, retention policy, topic max-message size, producer/client versions, active compression codecs and replication factor. Run `rpk cluster info -b --detailed` and `rpk cluster health`.
2. Record all topic names, `max.message.bytes`, `retention.ms`, under-replicated partitions, broker resource budgets and cluster license. Audit Schema Registry subjects beginning with `:.`; Redpanda 26.2 interprets these as context-qualified subjects by default. Remediate names before upgrading or explicitly defer enabling contexts for the migration.
3. Snapshot broker data with a **verified restore** and independently export critical source cursors, consumer offsets and the topic inventory. For important immutable events, test replay/rebuild against the restored broker. External backups should not rely on a copy of a live directory without an application-consistent snapshot.
4. For an existing stateful cluster, stage the **supported sequential feature-release upgrade path** from the current version (24.x may require intermediate 24.x, 25.x, and 26.1 upgrades). Rehearse each step against restored data and inspect the relevant Redpanda release notes for changes to topic retention, HTTP Proxy auth, FIPS credentials, Iceberg, Schema Registry and enterprise licensing.
5. On a production multi-broker deployment, upgrade **one broker at a time** with maintenance mode and healthy replication before proceeding. Docker Compose single-broker mode is for disposable development, **not production redundancy**. On 26.2, evaluate deferred finalization only when supported by the actual license and broker mode; do not assume rollback is possible after feature finalization.
6. After upgrade, reverify governed topics (including the raw Sync 9 MiB max), idempotent publishing, consumer-group offset continuity, exact serialized 5 MiB firehose round trip, Zstd and reconnect/replay behavior, and monitoring for under-replicated partitions, latency, disk, RSS, rejected writes and lag.
7. Remove the old broker volume only after reconciliation, a restore test and an explicit storage-retention decision. Never silently start with an empty log in place of authoritative persisted events.

## Redis 8.2 safe Streams activation

1. Inventory **all** Redis queue writers, including legacy `MAXLEN` writers, delayed promotions, DLQs, fanout scripts and services outside the sidecar. The new Redis 8.2 image alone cannot preserve old unread or PEL-pending work.
2. On persistent Redis stores, record server build, `INFO persistence`, AOF status, `CONFIG GET maxmemory maxmemory-policy`, `XINFO GROUPS`, `XPENDING`, `XLEN`, backlog age, replications and evictions. Back up the dataset and verify a disposable restore before Redis upgrade.
3. Upgrade the Redis server to 8.2.11 with its existing data intact using a supported backup/restore or in-place path. Keep a private network, protected ACL credentials, AOF `everysec` plus independently tested backup/restore, non-evicting work-queue storage and memory headroom. Note that `everysec` does **not** guarantee zero loss of the most recent writes on a hard crash.
4. Quiesce **every** producer before enabling PR #150's `REDIS_STREAM_ACKED_RETENTION=true` in all first-party sidecars and schedulers. Never mix the protected mode with any legacy writer that uses blind `MAXLEN` on the same stream.
5. Run the exact-head real Redis 8.2 admission and producer-concurrency proof, crash/reclaim, delayed promotion, DLQ saturation, network failure, 1/2/4-worker performance and recovery. Preserve queue source work when admission fails; observe 503/Retry-After at synchronous boundaries.
6. Track `MEMORY USAGE`/RSS, AOF disk growth, PEL oldest age, consumer lag, retries, rejected admissions, p95/p99, and storage cost. Entries are *not* a byte budget. Size per-queue capacity from measured average and p99 payload and headroom.
7. Roll back **application config** only after quiescing producers and proving work is preserved. Never downgrade a Redis 8.2 dataset to Redis 7 or resume unsafe `MAXLEN` writers on queues containing pending work.

## Cross-system acceptance

- A green unit test is insufficient: require actual Redis 8.2, Redpanda 26.2.6, multi-implementation federation (including Friendica in both modes), and deployment recovery.
- Record measured p95/p99, throughput, queue memory, broker disk and cost at 1/2/4 worker concurrency. No performance increase is claimed solely from version upgrades.
- Keep documented failure boundaries and failed CI visible. The Friendica receiving-202-but-no-Follow-persistence problem remains issue #149 and is not a reason to waive the protected federation workflow.

Official references:
- https://docs.redpanda.com/streaming/current/reference/releases/redpanda/
- https://docs.redpanda.com/streaming/current/upgrade/rolling-upgrade/
- https://docs.redpanda.com/streaming/current/upgrade/deferred-finalization/
- https://docs.redpanda.com/streaming/current/manage/schema-reg/schema-reg-contexts/
- https://redis.io/docs/latest/operate/oss_and_stack/install/version-mgmt/
- https://redis.io/docs/latest/commands/xtrim/
- https://redis.io/docs/latest/commands/xautoclaim/
