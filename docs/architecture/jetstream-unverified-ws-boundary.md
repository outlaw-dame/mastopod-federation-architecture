# Jetstream WebSocket trust boundary and backpressure

Jetstream's JSON frames are decoded events, **not cryptographic proof of
an ATProto repository commit**. The old optional intake route marked them
`signatureValid: true` and defaulted to the trusted `at.ingress.v1` topic.
That allowed an unverified network feed to cross a verification boundary.

## New contract

`AtJetstreamService` now refuses any publish topic other than
`at.jetstream.unverified.v1`. The main runtime defaults to that low-trust
topic and the topic is listed explicitly in governed Redpanda topology.
Events carry `kind: "jetstream.commit"`, `verified: false`, a bounded
timestamp and a decoded record, never a signature-validity assertion.
No signature-required ATProto consumer should read this topic as trusted.
The separate real AT firehose verifier remains the correct ingress path
for repository-signature and commit-chain checks.

This deliberately changes the previous experimental configuration:
enabling Jetstream with the old `AT_JETSTREAM_PUBLISH_TOPIC=at.ingress.v1`
now fails immediately rather than silently promoting unverified data.

## Resource bounds

The existing open-source `ws` client is retained. The subscription uses
WSS (except disposable loopback tests), a 1 MiB frame limit, no websocket
compression, no redirect following, and a ten-second handshake timeout.
The consumer pauses socket reads during asynchronous publishing and holds
at most eight pending messages and two MiB of pending message bytes.
A publish failure or exceeded queue budget tears down the connection
instead of allowing unbounded retained Promises or silently continuing
past an unacknowledged event.

After each acknowledged publish, the process retains the last observed
v1 timestamp cursor. Reconnects rewind that cursor by five seconds and
use capped exponential backoff with jitter. Replayed records must be
deduplicated by any downstream consumer. This is a **process-local**
recovery measure and **not** a durable cursor. Restarting the process
still needs a persistent cursor checkpoint and an explicit backfill
policy before this can be called a lossless production ingest.

The service no longer logs the complete subscription URL, remote
WebSocket close reason, per-event account DID or untrusted publisher
error messages. Messages missing a safe timestamp or a known operation
are ignored.

## Deployment gates

Provision `at.jetstream.unverified.v1` with limited write access,
short retention, monitoring and separate consumers before enabling
the optional ingress. Do not connect it to canonical content, identity,
moderation enforcement or private notifications without actual ATProto
verification. Measure downstream Redpanda p95/p99, paused socket time,
reconnect amplification, RSS over sustained bursts, duplicate rate and
cursor checkpoint durability in a multi-replica deployment.

The longer-term choice is between the existing durable, verified
`AtFirehoseConsumer` and an explicitly low-trust Jetstream discovery
path. Changing WebSocket libraries does not create missing verification
or persistence guarantees.

References:
- https://github.com/websockets/ws/blob/master/doc/ws.md
- https://github.com/bluesky-social/jetstream/blob/main/docs/README.md
- https://github.com/bluesky-social/bsky/blob/main/packages/jetstream/README.md

## Optional topic startup policy

The production prestart topic-governance verifier checks only the
topics required by enabled producers. `at.jetstream.unverified.v1` is
required if `ENABLE_AT_JETSTREAM=true`. The private
`canonical.notifications.dlq.v1` is likewise required only if
`ENABLE_CANONICAL_NOTIFICATION_DLQ=true`. Both are omitted when
disabled, so deploying this code does not require provisioning an
unused topic or disrupt unrelated sidecar startup. When enabled, the
normal partition, replication, retention and compression checks
remain mandatory. This is covered by four pure governance tests.
