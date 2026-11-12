# Canonical notification poison-message quarantine and Kafka offset ordering

**Code is present on a review branch; the quarantine producer is disabled by
default. Do not activate before the dedicated Redpanda topic exists with
restricted ACLs for private data.**

## Problem corrected

The original Kafka consumer committed offsets for malformed/empty events
even when earlier notification HTTP calls were still in progress. Thus
a single invalid record could advance Kafka's committed position across
an unacknowledged notification. A later process crash could lose it.

The new consumer handles every message in the same bounded, ordered
concurrency window. It waits for **all** in-flight HTTP or quarantine
publishes to complete before resolving any offset in the window. If one
operation fails, it commits **none** of that window. Previously
accepted notifications replay through the PostgreSQL canonical ledger.

Malformed or empty records, invalid actionable notification schemas and
deterministically rejected 400/413/422 webhook payloads can be parked
in `canonical.notifications.dlq.v1`. A record includes the source
(topic, partition, offset), fixed reason code, payload digest and
base64-encoded original bytes (maximum 256 KiB) for exact forensic
replay. This topic is *not* a public ActivityPub feed; it may contain
private information. The governed topic uses seven-day retention
and should have narrowly scoped read/write ACLs and audited replay
permissions. The Kafka producer requests `acks=-1`, no automatic
topic creation, idempotent producer per process and no more than one
in-flight produce request. Any DLQ failure leaves the source offset
unresolved, rather than silently throwing away user notifications.
Oversized events fail closed rather than being copied to another topic.

The quarantine publisher is connected only when
`CanonicalNotificationConsumerConfig.enableDeadLetter=true` is
explicitly supplied by the trusted runtime, after provisioning the
topic. A disabled publisher fails closed on malformed notifications.
It cannot be silently enabled by an HTTP client.

## Remaining production and cost boundaries

The Kafka consumer does not atomically commit source offsets with
quarantine publishing; a crash after the DLQ write but before offset
commit can create duplicate quarantine records. Consumer idempotency
should be keyed by `sourceTopic:partition:offset` on replay.
The sidecar and ActivityPods must be upgraded together, and the
PG per-recipient ledger enabled only after its production acceptance.
Network partitions, poison flood behavior, topic retention/cost,
ACL enforcement and a controlled kill/recovery benchmark are still
required. Existing valid non-notification canonical kinds remain
ignored intentionally, rather than generating notifications.
