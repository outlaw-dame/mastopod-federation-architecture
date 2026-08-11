# APDM Phase 4 — Sidecar durability and duplicate suppression

The ActivityPods producer uses a durable Bull handoff job whose payload is the authoritative `ap.delivery-plan.v1`.

The existing sidecar `/webhook/outbox` endpoint acknowledges with HTTP 202 only after `queue.enqueueOutboxIntent()` has written the intent into the Redis Stream. ActivityPods therefore treats 202 plus `accepted: true` as the durable sidecar acceptance boundary.

The legacy webhook currently assigns its own sidecar intent-record ID. The stable APDM Delivery Plan ID is retained in `meta.deliveryPlanIntentId` and the `X-APDM-Intent-Id` request header.

Response-loss/retry safety is provided by the execution layer:

```text
same Activity + same delivery URL
        |
        v
same outbound jobId = activityId::deliveryUrl
        |
        v
OutboundWorker.checkIdempotency()
        |
        +-- new       -> one remote HTTP delivery
        +-- duplicate -> acknowledge/skip
```

`fedify-sidecar/src/delivery/tests/DurableHandoffIdempotency.test.ts` proves both the deterministic job-ID derivation across separate accepted sidecar intent records and the pre-send duplicate suppression behavior.

Phase 4 does not perform the production authority cutover. That remains APDM Phase 5.
