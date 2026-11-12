# External Sync source lease: Redis Cluster slot and v1 → v2 migration

## Why this change is required

Source fencing uses one atomic Redis Lua operation involving up to three keys
(owner, acknowledged cursor, committed cursor). Redis Cluster rejects a
multi-key script if the keys are in different hash slots. The old v1 names
(`at:external-sync:v1:<sha256-prefix>:owner|epoch|hot|committed`)
have no shared hash tag and are **not Cluster-safe**.

The v2 layout is:

```text
at:external-sync:v2:{<40-hex source SHA-256 prefix>}:owner
at:external-sync:v2:{<40-hex source SHA-256 prefix>}:epoch
at:external-sync:v2:{<40-hex source SHA-256 prefix>}:hot
at:external-sync:v2:{<40-hex source SHA-256 prefix>}:committed
```

The braces make all keys for one source occupy the same Redis Cluster
hash slot, while distributing *different* sources across slots. They do
not convert an ordinary single-endpoint `Redis` client into a Cluster-aware
client. Deployment configuration and a real Cluster proof are **still required**
before a multi-shard Redis Cluster rollout.

## Fail-closed upgrade behavior

Before taking a v2 lease, the sidecar checks the corresponding old v1
`owner`, `hot`, and `committed` keys. If **any** old value exists, it
refuses the source rather than silently treating a nonzero old checkpoint
as a brand-new stream. Redis read failures also refuse the source.

This is deliberate. A first-live deployment on a fresh Redis database uses
v2 directly. An existing environment with v1 cursor data must perform a
controlled migration. Do not delete old keys merely to make startup pass.

## Controlled migration checklist

1. Disable external verified ingestion at the deployment boundary. Drain
   **every old-version replica** that can write the v1 namespace, not just the
   primary replica. Keep Jetstream disabled. Confirm that all source sockets
   and in-flight broker operations are stopped.
2. Take a Redis snapshot/backup and record the source URL plus its exact
   40-hex SHA-256 prefix; confirm the Redis instance/cluster is the correct
   one. Export both v1 committed and hot cursors, including key presence.
3. Check the v1 committed checkpoint is canonical decimal and safe. **Resume
   from the last durable committed checkpoint** rather than assuming the
   higher hot cursor is durably committed. Confirm any broker replay window
   and downstream idempotency cover it.
4. While all external writers remain stopped, seed the v2 `hot` and
   `committed` keys to that committed sequence only, using conditional
   `SET ... NX` plus a post-write verification. If v2 keys already exist,
   stop and reconcile them rather than overwriting a potentially newer
   checkpoint. Keep the v2 `owner` absent; v2 will allocate a new owner
   token/epoch after startup.
5. Verify the new cursor values, save the migration evidence, remove old
   **v1** source keys only once the old clients are known dead, and re-enable
   the verified source on the v2 deployment. Confirm the resumed inclusive
   stream, accepted broker offsets and source-specific monitoring.
6. Run a leader-loss/restart scenario and verify no cursor regression,
   missed events, or unexpectedly high replay amplification before
   production traffic.

If only a hot cursor exists and no committed checkpoint exists, do **not**
automatically promote it. Resolve that case using broker acknowledgment
evidence and authenticated repository synchronization.

## Operational recommendations from primary docs

- Keep coordination keys and durable Stream queues on a Redis service
  configured for reliability, not an evicting cache. `maxmemory-policy
  noeviction` is appropriate for the authority/queue domain, with metrics
  and admission backpressure rather than silent loss of keys.
- Redis replication is asynchronous; Cluster hash tags and Lua atomicity
  do not establish linearizable durable consensus or prevent data loss from
  primary failover. Prove AOF/persistence and takeover under a real failure.
- Prefer shared, long-lived clients, brief bounded Lua operations and bounded
  pipelines. Track `INFO memory`, `INFO persistence`, `INFO replication`,
  `SLOWLOG`, `LATENCY LATEST`, eviction counts, and per-source checkpoints.
- Keep Redis in a private network with TLS and minimal ACLs. Never expose the
  scripting-enabled credential to untrusted clients.

References:
- https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
- https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/
- https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/
- https://redis.io/docs/latest/commands/waitaof/
