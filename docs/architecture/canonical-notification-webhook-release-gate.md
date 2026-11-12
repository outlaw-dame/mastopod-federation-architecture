# Canonical notification webhook release gate (November 2026)

The original CanonicalNotificationConsumer used a catch-and-log wrapper around
each webhook delivery, then called Kafka `resolveOffset` and committed the
batch, even if the HTTP call failed or returned 404/503. ActivityPods' bridge
also used to mark an intent processed after failed/partial delivery. This
combination could permanently lose cross-protocol notifications.

## Coordinated recovery change

The sidecar now leaves the Kafka offset unresolved when the ActivityPods
transport fails or returns anything other than the bridge's processing
acknowledgments (202 complete, 409 already complete). Batch processing does
not suppress promise rejections before offset resolution. Concurrency is capped
at eight per consumer and the HTTP call timeout must be 500–30000 ms. The
bridge counterpart is in ActivityPods PR #149 (stacked on #148).

These changes establish **at-least-once intent**, not exactly-once delivery.
Failures can cause earlier successful batch deliveries to replay. ActivityPods
still has in-memory dedupe keyed by the canonical intent, not a durable
per-recipient ledger; a process restart or different worker can redeliver an
already notified recipient. That remaining gap is release-blocking. For a
full production cutover, persist per-intent/recipient delivery claims, leases,
completion and retries behind one backend authority, verify canonical payload
fingerprints and replay without duplicates across workers and process kills.
Do not mark a delivery completed before the recipient's notification record is
durable. Timeouts, partitions and a poisoned event need bounded DLQ parking
with an acknowledged durable audit record; otherwise a permanently malformed
event may stall this consumer indefinitely.

The sidecar currently skips empty messages, malformed JSON events and
non-notification kinds. A production poison-message path requires durable
quarantine/audit before skipping actionable invalid records. It is not
completed by this patch.

## Acceptance

A focused Vitest regression asserts failed delivery does not resolve or
commit the Kafka offset, and successful delivery does. Complete sidecar CI,
real Redis/Redpanda integration, HTTP 202/409/503 and worker-kill proofs on
the exact final commit are needed before promotion.

## AT ingress forwarder: bounded webhook delivery work

The separate `AtIngressWebhookForwarder` previously processed every endpoint
and 50-event chunk sequentially, allowing a slow endpoint to stall all others
for multiple per-request timeouts and retries. It now runs at most four
independent endpoint workers, maintains chunk order within each endpoint,
and retains output order by endpoint. Each live chunk is JSON-serialized
once before retries, instead of repeatedly allocating large JSON strings.
HTTP 429 is treated as retryable backpressure within the existing bounded
retry budget, and redirects are rejected rather than forwarding credentials.

URL registration now rejects non-TLS remote destinations, embedded
credentials, and URL fragments (only non-production HTTP loopback remains).
The inherited `X-Bridge-Secret` header is a **raw shared secret**, not the
HMAC-SHA256 signature claimed by old comments. It remains temporarily for
the existing downstream contract. Replacing it requires a versioned signed
header and coordinated downstream verification; this change deliberately
does not invent a breaking signature scheme.

These optimizations are static-code and unit-test improvements only. They
are not evidence of deployed webhook p95, downstream readiness, or end-to-end
durability. A later capacity gate should measure response times, upstream
retries, memory/RSS, and per-endpoint backlog under controlled loss.
