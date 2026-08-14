# APDM Phase 6 — Federation raw-routing retirement

## Scope

`APDM-P6-F` removes the federation-side ability for the retired raw ActivityPods outbox emitter shape to act as a remote-routing authority after the Phase 5 cutover.

Phase 5 established that external delivery is:

`ActivityPods authoritative ap.delivery-plan.v1 -> durable Bull handoff -> /webhook/outbox -> outbox-intent queue -> Fedify/native sidecar executor`

The sidecar must therefore distinguish that internal handoff from the older compatibility payload that reconstructed `remoteTargets` independently from a committed raw Activity.

## Wire authority proof

The ActivityPods durable handoff adds transport-only metadata to each `remoteTargets` member:

```json
{
  "apdmAuthority": {
    "schema": "ap.delivery-plan.v1",
    "intentId": "<stable Delivery Plan intentId>"
  }
}
```

This marker does **not** change the `ap.delivery-plan.v1` schema. It binds the sidecar webhook target list to the already-authoritative Delivery Plan identity at the internal transport boundary.

Before URL normalization or shared-inbox deduplication, `normalizeAndDedupeOutboundTargets` now requires:

1. every target to carry the marker;
2. the marker schema to equal `ap.delivery-plan.v1`;
3. a non-empty, already-trimmed `intentId`;
4. every target in the request to carry the same intent ID.

Missing, malformed, or mixed authority markers reject the entire request with HTTP-validation semantics rather than being counted as an invalid target and partially accepted.

## Interoperability harness exception

The containerized AP interoperability harness still constructs synthetic webhook input instead of running ActivityPods itself. Unmarked targets are accepted only when both of these are true:

- `NODE_ENV` is explicitly `test` or `development`; and
- the target hostname is explicitly present in `APDM_INTEROP_PRIVATE_HOSTS`.

Unset, unknown, staging, and production environments fail closed even if the interop host allowlist is accidentally present. This exception exists only to preserve the real Mastodon/Akkoma/GoToSocial executor interoperability proof; it is not a deployment compatibility mode.

## Removed compatibility artifact

The stale copied `fedify-sidecar/activitypods-integration/outbox-emitter.service.js` has been removed. It independently parsed/routed committed Activity data and directly submitted sidecar federation work, which is incompatible with the post-Phase-5 authority model.

Other ActivityPods integration helpers are not removed merely because they perform ActivityPub resolution: bridge/media/profile helpers have separate responsibilities and must be evaluated in their own phases rather than deleted by name.

## Invariants

`APDM-P6-F` preserves:

- internal sidecar-generated outbox intents such as relay subscriptions and moderation reports;
- target URL validation and shared-inbox deduplication after authority proof;
- Phase 5 SSRF/pinned-DNS execution protections;
- outbox-intent durability, retry, residence, and DLQ behavior;
- AP interoperability tests against real server implementations.

It removes only the old ActivityPods raw-routing submission as a production authority.

## Exit gate

Phase 6 is PASS only when both `APDM-P6-A` and `APDM-P6-F` are merged with exact-head CI and fresh review clean. Phase 7 must not begin before that cross-repository gate closes.
