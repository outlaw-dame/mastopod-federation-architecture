# APDM Phase 6 — Federation raw-routing retirement

## Scope

`APDM-P6-F` removes the federation-side ability for the retired raw ActivityPods outbox emitter shape to act as a remote-routing authority after the Phase 5 cutover, while preserving native rollback indexing through a separate non-federating observation transport.

Phase 5 established that external delivery is:

`ActivityPods authoritative ap.delivery-plan.v1 -> durable Bull handoff -> /webhook/outbox -> outbox-intent queue -> Fedify/native sidecar executor`

The sidecar must therefore distinguish that authoritative handoff from the older compatibility payload that reconstructed `remoteTargets` independently from a committed raw Activity.

## External handoff authority proof

The ActivityPods durable handoff carries the same stable Delivery Plan identity in four places:

1. every `remoteTargets` member:

   ```json
   {
     "apdmAuthority": {
       "schema": "ap.delivery-plan.v1",
       "intentId": "<stable Delivery Plan intentId>"
     }
   }
   ```

2. request header `X-APDM-Intent-Id`;
3. `meta.deliveryPlanSchema`;
4. `meta.deliveryPlanIntentId`.

The target marker does **not** change the `ap.delivery-plan.v1` schema. It binds the already-resolved target list to the authoritative plan at the internal transport boundary.

At `/webhook/outbox`, the sidecar now fails closed unless a production handoff proves all of the following before Redis enqueue:

- every target marker uses schema `ap.delivery-plan.v1`;
- every target carries one non-empty, already-trimmed intent ID;
- all target markers have the same intent ID and the same authority provenance;
- `meta.deliveryPlanSchema` is exactly `ap.delivery-plan.v1`;
- `meta.deliveryPlanIntentId` equals the target marker intent ID;
- `X-APDM-Intent-Id` equals that same intent ID.

The sidecar durable `OutboxIntent.intentId` is then set to that same stable Delivery Plan intent ID rather than a newly generated UUID. Missing or mismatched identities reject the request with HTTP 400 semantics before queue insertion.

This makes the identity chain:

`Delivery Plan intentId == target marker intentId == X-APDM-Intent-Id == meta.deliveryPlanIntentId == sidecar OutboxIntent.intentId`

## Interoperability harness exception

The containerized AP interoperability harness still constructs synthetic webhook input instead of running ActivityPods itself. Unmarked targets are accepted only when both of these are true:

- `NODE_ENV` is explicitly `test` or `development`; and
- the target hostname is explicitly present in `APDM_INTEROP_PRIVATE_HOSTS`.

The normalizer records the **provenance** of this exception as `interop_legacy`. The validator never infers exception status from a magic intent-ID string. Therefore a production caller cannot forge the historical interop sentinel value inside an otherwise valid `ap.delivery-plan.v1` marker to bypass header or metadata binding.

Unset, unknown, staging, and production environments fail closed even if the interop host allowlist is accidentally present. This exception exists only to preserve the real Mastodon/Akkoma/GoToSocial executor interoperability proof; it is not a deployment compatibility mode.

## Native rollback observation path

Native rollback keeps SemApps `remotePost` as the sole ActivityPub remote-delivery executor. Removing the legacy emitter webhook must not remove public-event indexing, so native mode uses a separate endpoint:

`POST /webhook/outbox-observation`

The ActivityPods emitter sends only:

- `actorUri`;
- `activityId`;
- committed `activity`;
- search/indexability `meta`;
- `X-Event-Id`;
- `X-Event-Schema: ap.outbox.committed.v1`.

It sends no `remoteTargets` or `deliveryTargets`. The sidecar rejects an observation request that contains either field.

The sidecar creates a durable OutboxIntent with:

- `targets: []`;
- stable retry identity `apdm-observation:<X-Event-Id>`;
- `bridgeHints.observationOnly = true`.

`OutboxIntentWorker` recognizes this marker **before** shared-inbox discovery, target normalization, or outbound-job construction. An observation-only intent must have zero targets; otherwise it fails permanently. A valid observation intent:

1. publishes the existing Stream1/tombstone event-log path;
2. records event-log completion state;
3. calls the existing atomic zero-job fan-out operation;
4. records `jobCount = 0`;
5. marks the intent completed and acknowledges it;
6. returns without creating any outbound delivery job.

This preserves native-mode indexing while making the observation path structurally incapable of becoming a second federation authority.

## Removed compatibility artifact

The stale copied `fedify-sidecar/activitypods-integration/outbox-emitter.service.js` has been removed. It independently parsed/routed committed Activity data and directly submitted sidecar federation work, which is incompatible with the post-Phase-5 authority model.

Other ActivityPods integration helpers are not removed merely because they perform ActivityPub resolution: bridge/media/profile helpers have separate responsibilities and must be evaluated in their own phases rather than deleted by name.

## Invariants

`APDM-P6-F` preserves:

- SemApps native remote execution in rollback mode;
- Stream1/search observation in native mode without any remote-delivery targets;
- internal sidecar-generated outbox intents such as relay subscriptions and moderation reports;
- target URL validation and shared-inbox deduplication after authority proof;
- Phase 5 SSRF/pinned-DNS execution protections;
- outbox-intent durability, retry, residence, and DLQ behavior;
- AP interoperability tests against real server implementations.

It removes only the old raw-Activity recipient-routing submission as a production federation authority.

## Exit gate

Phase 6 is PASS only when both `APDM-P6-A` and `APDM-P6-F` are merged with exact-head CI and fresh review clean. Phase 7 must not begin before that cross-repository gate closes.
