# APDM Phase 4 — Sidecar durability and duplicate suppression

The ActivityPods producer uses a durable Bull handoff job whose payload is the authoritative `ap.delivery-plan.v1`.

The sidecar `/webhook/outbox` endpoint acknowledges with HTTP 202 only after `queue.enqueueOutboxIntent()` has written the intent into the Redis Stream. ActivityPods therefore treats HTTP 202 plus `accepted: true` as the durable sidecar acceptance boundary.

The legacy webhook currently assigns its own sidecar intent-record ID. The stable APDM Delivery Plan ID is retained in `meta.deliveryPlanIntentId` and the `X-APDM-Intent-Id` request header.

## Deterministic execution identity

Separately accepted sidecar intent records for the same Activity and delivery URL converge on the same outbound identity:

```text
same Activity + same delivery URL
        |
        v
same outbound jobId = activityId::deliveryUrl
```

This convergence is necessary but not sufficient for crash safety. Phase 4 therefore separates **temporary execution claims** from **completed-delivery proof**.

## Crash-safe delivery state

```text
ready Redis Stream outbound message
        |
        +-- future notBefore --> atomic delayed ZSET/hash handoff + XACK
        |                         |
        |                         v
        |                    due promotion -> ready Stream
        v
temporary in-flight claim (expiring, owner token)
        |
        +-- another worker sees claim --> durable defer, do not mark delivered
        |
        v
remote HTTP delivery
        |
        v
durable v2 completed marker
        |
        v
XACK original Stream message
```

The completed marker is the only duplicate-delivery proof. An in-flight claim is never interpreted as successful delivery.

If a worker dies after acquiring its claim but before sending HTTP, the claim expires and the reclaimed Stream message becomes deliverable. If another worker encounters the live claim before expiry, it durably enqueues deferred replacement work before acknowledging the current Stream message.

Future-dated outbound jobs do **not** remain parked in the ready Stream's pending-entry list. The ready Stream is deliberately `MAXLEN`-trimmed, so long-lived pending entries are not a safe delay store. Instead, the queue atomically stores the complete job payload in a Redis hash, records its due timestamp in a sorted set, and acknowledges the ready Stream entry in the same Redis script. A short promotion loop atomically recreates due work in the ready Stream and removes the delayed record. This prevents hot requeue loops, prevents trimming from deleting delayed work, and avoids `XAUTOCLAIM` cursor fairness/head-of-line behavior for scheduled retries.

If remote HTTP succeeds but the completed marker cannot be persisted, the worker intentionally does not acknowledge the Stream message. This preserves at-least-once delivery: a later replay may duplicate the remote HTTP request, but the Activity is not silently lost.

All retry/defer/DLQ transitions persist their replacement or recovery record before acknowledging the original Stream message. If that persistence fails, the source remains pending and reclaimable rather than creating an `ACK -> write failure -> lost work` gap.

`RedisOutboundDeliveryClaimStore` uses ownership tokens so a stale worker cannot release another worker's claim. Completion and claim release are performed with Redis-side token checks.

## Replay-horizon guarantee

Phase 4's automatic no-duplicate guarantee is bounded explicitly rather than assuming either producer processing or queue residence is instantaneous.

ActivityPods automatic delivery reconciliation may inspect at most the preceding **48 hours**. Blind-recipient recovery snapshots remain private and expire after **72 hours**, leaving a full **24-hour producer-processing allowance** for account-cursor rotation, paging, Activity refetch, and plan reconstruction before the sidecar accepts the reconstructed intent. Configurations above 48 hours fail closed instead of allowing automatic reconciliation to race the blind-recipient snapshot expiry.

After durable sidecar acceptance, the outbox-intent stage may retain an intent for at most **48 hours**. The bound uses the intent's original `createdAt`, which is preserved across retries, so retry/requeue cannot reset the residence clock. Stale intents are durably moved to the DLQ before their source Stream message is acknowledged and before they can create outbound replay work. The worker revalidates that original age again immediately before outbound fan-out, so time spent in target enrichment or event-log publication cannot silently extend the residence window.

An outbound Redis Stream message may then wait at most **48 hours** before its first completed-delivery claim check. The worker derives this residence from a fully validated Redis millisecond Stream ID (`<milliseconds>-<sequence>`) and DLQs stale messages before claiming or performing any HTTP delivery. If the Stream ID is malformed or implausibly ahead of the worker clock, age validation fails closed and the job is DLQ'd rather than delivered. A completed duplicate is checked before rate-limit/concurrency defer paths, so a reconciliation-generated duplicate cannot reset this first-check residence clock before consulting the completed marker.

Both sidecar age checks permit at most **5 minutes of positive clock skew**. Because that allowance can apply independently to the outbox-intent and outbound-message stages, the formal automatic replay bound includes **10 minutes** of skew in addition to the four nominal timing terms.

The production completed-delivery ledger enforces an **eight-day minimum** retention period for successful `activityId::deliveryUrl` markers. A shorter worker configuration is clamped by the storage layer, while a longer configured retention remains valid. The eight-day floor therefore exceeds the complete worst-case bounded automatic duplicate path by **23 hours 50 minutes**.

### Legacy completion-marker cutover

The pre-hardening sidecar wrote unversioned `ap:delivery:completed:<jobId>` markers with a much shorter lifetime. That namespace cannot be upgraded safely with an incremental rolling `SCAN`: the old format contains no durable index or version metadata, so a key may expire before an incremental cursor observes it. Repeatedly extending every key is also incorrect because it would keep upgraded completion proof alive forever.

The migration therefore uses an explicit **maintenance cutover**, not mixed-version rolling workers:

1. deploy the ActivityPods producer bound that limits automatic reconciliation to 48 hours;
2. stop all legacy outbound sidecar workers so no new v1 completion markers can be written;
3. start the upgraded sidecar with `APDM_COMPLETION_MARKER_V2_CUTOVER=maintenance` if legacy markers exist;
4. before the queue starts consuming work, a one-time atomic Redis namespace conversion copies each legacy marker to `ap:delivery:completed:v2:<jobId>` with the eight-day retention floor and deletes the legacy key;
5. the conversion writes a permanent migration sentinel, so subsequent restarts never repeat the blocking namespace operation;
6. start only upgraded workers after the cutover.

A fresh Redis installation with no legacy markers writes the sentinel automatically and does not require the maintenance flag. If legacy markers are present and the flag is absent, startup fails closed before queue consumption.

New completions write only v2 markers. Claim-time logic defensively recognizes a stray legacy marker, upgrades that individual marker to v2, and treats the job as completed. There is **no periodic TTL-extension sweep**, so a v2 marker naturally expires after its bounded retention window instead of being refreshed forever.

The one-time migration deliberately uses an atomic Redis namespace operation. That can briefly block Redis and is therefore restricted to the documented maintenance boundary; correctness is preferred over pretending an incremental cursor can provide a snapshot guarantee that Redis `SCAN` does not provide.

The cross-repository automatic-replay invariant is therefore:

```text
producer reconciliation age        <= 48 hours
producer processing allowance      <= 24 hours
sidecar outbox-intent residence     <= 48 hours
first outbound-message residence    <= 48 hours
accepted sidecar clock skew         <= 10 minutes total
-------------------------------------------------
maximum automatic duplicate age     <= 168 hours 10 minutes
completed-delivery marker retention >= 192 hours (8 days)
safety margin                        >= 23 hours 50 minutes
```

Separately, the private blind-recipient recovery invariant remains:

```text
producer reconciliation lookback <= 48 hours
producer processing allowance    <= 24 hours
blind-recipient snapshot lifetime = 72 hours
```

Manual/operator replay outside the bounded automatic window is not covered by the automatic no-duplicate guarantee and must be treated as an explicit recovery operation.

## Tests

`fedify-sidecar/src/delivery/tests/DurableHandoffIdempotency.test.ts` proves:

- two separately accepted sidecar intent records for the same Activity/target derive the same outbound `jobId`;
- a dead worker's still-live in-flight claim is not mistaken for completed delivery;
- reclaimed work becomes deliverable after the stale claim expires;
- a duplicate is suppressed only after completed-delivery state has been recorded;
- stale outbox intents are DLQ'd before outbound replay work is created, including revalidation immediately before fan-out;
- stale outbound Redis messages are DLQ'd before the completed-delivery claim check or external delivery.

`fedify-sidecar/src/delivery/tests/ApdmReplayHorizon.test.ts` proves the 48h + 24h + 48h + 48h + 10m automatic duplicate bound, the eight-day completed-marker floor, the 23h50m safety margin, complete Redis Stream-ID validation, and fail-closed timestamp handling.

`fedify-sidecar/src/delivery/tests/OutboundDeliveryClaimRetention.test.ts` proves the eight-day storage floor, longer-retention preservation, non-finite fail-safe behavior, distinct legacy/v2 namespaces, and the permanent one-time migration sentinel/maintenance mode contract.

Phase 4 does not perform the production authority cutover. That remains APDM Phase 5.
