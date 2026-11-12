# Jetstream WebSocket intake hardening

## Trust boundary

Jetstream JSON is not an authenticated, signed repository operation.
Do not translate it into `AtIngressEvent`, set `signatureValid=true`
or place it directly in `at.ingress.v1`. That topic is reserved for
events verified by the ATProto repository/CID/DID verification pipeline.

The optional Jetstream client now publishes only observations with
`verified:false` into `at.jetstream.unverified.v1`. A separate verifier
must compare the repository state, DID document, CID and revision before
any observation can enter trusted ingress. The topic has one partition,
a three-day retention window, and is only included in topic governance
when `ENABLE_AT_JETSTREAM=true`. The default destination no longer
inherits the verified-AT topic setting.

This is a **staging boundary**, not a complete verified ingestion path.
An observation may be lost on process restart until a durable checkpoint
store and the verifier are installed. The topic is never consumed by
the trusted bridge automatically.

## WebSocket flow control

Only one event is published to the broker at a time, in receive order.
The `ws` socket is paused while the publish is pending and resumed only
after the drain loop relinquishes ownership. Any pending burst is bounded
to sixteen messages and eight MiB; exceeding either terminates the
connection and reconnects from the most recently acknowledged cursor.
The client does not silently swallow publisher failures.

Incoming frames are limited to five MiB, compression via
`permessage-deflate` is disabled, and a 30-second ping/pong liveness
check terminates half-open connections. Reconnect uses capped full
jitter rather than synchronizing all replicas. A trusted broker
acknowledgment advances the in-memory cursor; the legacy v1 timestamp
cursor rewinds five seconds on reconnect and may replay duplicates.
Jetstream v2 uses its sequence cursor and also replays the inclusive
last event. Downstream consumers must be idempotent by AT URI/record
revision. A cursor is not transferable between Jetstream servers.

## Remaining acceptance and cost controls

Before enabling Jetstream in production, add a durable, per-upstream
acknowledged cursor with atomic restart recovery, monitor age and
retention of staging records, verify repository signatures and account
delete/sync semantics, and exercise publisher/Redpanda outages and
queue saturation under multi-hour load. Staging does not bypass the
authoritative CBOR/CAR-based verification route. Switching to another
WebSocket library alone cannot fix a missing verification boundary or
infinite publisher backlog.

References: Bluesky Protocol Services Jetstream v2 specifications,
`@atproto/ws-client` backpressure, and `ws` server/client API.
