# External firehose raw-event replay suppression

The prior Redis deduplication path used the DID sanitizer on a **relay URL**
(`wss://…`), so it always failed the input check and returned `false`
without marking processed events. Duplicate raw events were therefore eligible
for repeated trusted publication.

The replacement hashes the full source URL into a stable source-scoped
Redis key and remembers recently processed integer sequences in a sorted set.
Each source's set is bounded to **32,768 sequence entries**, with 24-hour
expiry when idle; the bound is independent of firehose event rate and uptime.
A test-only/configurable window is limited to 16–65,536 entries.

Redis missing or unavailable during a duplicate check or checkpoint is a
**retry**, not an authorization to process the event as new. The verifier
returns a retry decision to its Redpanda consumer and does not advance its
offset on these failures. This preserves safety under transient Redis errors.

This is **bounded duplicate suppression**, not exactly-once delivery:
- A replay beyond the retained 32,768-entry window can be processed again.
- The broker-ack-then-dedupe-checkpoint sequence is not a single atomic
  transaction across Redis and Redpanda; a process crash between them can
  cause duplicate publication.
- Independent workers can check the same sequence simultaneously before
  either marks it processed. The raw topic should be partitioned by stable
  repository/source keys as appropriate, and canonical consumers need durable
  idempotency.
- Scale tests must record Redis key cardinality/memory, processed event
  throughput, replay frequency and cost before production release.

Do not extend the retention window unboundedly. At 2,000 events/second,
a unique 24-hour Redis key per event would create roughly 173 million keys
per source, which is not an acceptable default for Paper.
