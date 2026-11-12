# External Sync v1.1 firehose intake: ordered resource bounds

## Scope

This is the *external* `com.atproto.sync.subscribeRepos` raw-ingest
consumer. It does not replace local Paper/PDS firehose publication and does
not activate canonical ATProto authority. Jetstream remains the separately
selected **unverified** alternative (see the primary-ingestion decision doc).

## Implementation contract

- Use secure `wss://` for remote relays/PDSs; only disposable loopback tests
  may use `ws://`. Disable redirects and per-message deflate, use a ten-second
  handshake timeout and a 5 MiB incoming frame cap.
- A socket has one outstanding broker publish and no more than two queued
  messages / 10 MiB pending queue bytes. Pause upstream reads during slow
  publishing and terminate on queue exhaustion; a reconnect replays only from
  acknowledged checkpoints. Reconnection uses capped jitter and is canceled
  on shutdown.
- Publish raw CBOR only to the separately governed `at.firehose.raw.*.vN`
  namespace. Pass the same configured topic to the producer and verifier.
  Never write raw/unverified bytes directly to `at.ingress.v1`.
- Cursor advances only **after broker acknowledgment and hot cursor write**.
  Frames from prior sessions cannot update a new session's cursor. Resume
  cursors are inclusive, so same-process duplicates through the acknowledged
  sequence are skipped. A process restart may replay from the durable
  checkpoint and must rely on downstream idempotency.
- Commit checkpoints are serialized and monotonically nondecreasing within
  the process. Redis read failures or invalid sequences are errors, not a
  fresh live-only subscription. Shutdown releases sockets, timers and
  pending reconnect waits; it never waits indefinitely for a stalled broker
  promise.
- A partially started multi-source runtime stops already started source
  sockets if any subsequent source fails.

## Outstanding acceptance

The per-process bounds are **not** a fleet-wide byte budget or throughput
claim. Source IDs and their cursors are relay-specific. Before production
activation, verify broker partitioning and deduplication, source leasing
across replicas, durable checkpoint consistency under crash/partition,
`#sync` authenticated rebuild, DID resolution/SSRF limits, and real
1/2/4 replica load on representative network and storage.

Measure sustained p50/p95/p99 ingest, verification and delivery latency,
maximum process RSS, heap after GC, queued socket bytes, incoming frame
size distribution, broker lag, retry amplification and stream gaps. Include
resumed streams and a deliberately stalled broker.

References:
- https://atproto.com/specs/sync
- https://atproto.com/specs/event-stream
- https://atproto.com/blog/relay-updates-sync-v1-1
