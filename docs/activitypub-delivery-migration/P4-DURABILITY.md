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
Redis Stream outbound message
        |
        v
temporary in-flight claim (expiring, owner token)
        |
        +-- another worker sees claim --> defer/requeue, do not mark delivered
        |
        v
remote HTTP delivery
        |
        v
durable completed marker
        |
        v
XACK original Stream message
```

The completed marker is the only duplicate-delivery proof. An in-flight claim is never interpreted as successful delivery.

If a worker dies after acquiring its claim but before sending HTTP, the claim expires and the reclaimed Stream message becomes deliverable. If another worker encounters the live claim before expiry, it durably enqueues deferred replacement work before acknowledging the current Stream message.

If remote HTTP succeeds but the completed marker cannot be persisted, the worker intentionally does not acknowledge the Stream message. This preserves at-least-once delivery: a later replay may duplicate the remote HTTP request, but the Activity is not silently lost.

All retry/defer paths insert their durable replacement before acknowledging the original Stream message, avoiding an `ACK -> crash -> requeue` loss window.

`RedisOutboundDeliveryClaimStore` uses ownership tokens so a stale worker cannot release another worker's claim. Completion and claim release are performed with Redis-side token checks.

## Tests

`fedify-sidecar/src/delivery/tests/DurableHandoffIdempotency.test.ts` proves:

- two separately accepted sidecar intent records for the same Activity/target derive the same outbound `jobId`;
- a dead worker's still-live in-flight claim is not mistaken for completed delivery;
- reclaimed work becomes deliverable after the stale claim expires;
- a duplicate is suppressed only after completed-delivery state has been recorded.

Phase 4 does not perform the production authority cutover. That remains APDM Phase 5.
