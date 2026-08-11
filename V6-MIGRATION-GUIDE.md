# V6 Migration Guide — Historical

> **Historical document. Do not use this file as the current runtime or deployment architecture.**
>
> The original V6 migration work temporarily proposed consuming ActivityPub delivery work directly from Redpanda and using Redis only for delivery state. That design has been superseded.

The current authoritative architecture is documented in:

- `ARCHITECTURE-BASELINE.md`
- `docs/activitypub-delivery-migration/README.md`
- `docs/activitypub-delivery-migration/PHASES.md`
- `docs/activitypub-delivery-migration/STATUS.md`
- `docs/atproto-authority-convergence.md`

## Superseded queue model

The historical V6 guide described this as the desired outbound path:

```text
ActivityPods
  -> ap.outbound.v1 / Redpanda
  -> delivery worker
  -> remote ActivityPub HTTP
```

That is **not** the current authority model.

The governing invariant is now:

```text
Redis / Redis Streams / Bull
  = operational work that is claimed, retried, acknowledged, delayed,
    dead-lettered, leased or deduplicated

Redpanda
  = durable replayable event facts for independent consumers
```

For ActivityPub remote delivery, current APDM work uses the durable Redis-backed handoff and outbound worker path. Redpanda may record/publicize resulting facts, but it is not the retry/delivery work queue.

Likewise, inbound ActivityPub processing uses the current Redis queue + verification/MRF worker path before accepted public events are published to Redpanda Stream 2 / firehose topics.

## Native event streams remain valid

Retiring the old Redpanda-as-work-queue worker does **not** retire the public/event topology. The architecture still uses durable Redpanda streams such as:

- `ap.stream1.local-public.v1`
- `ap.stream2.remote-public.v1`
- `ap.firehose.v1`
- native AT topics such as `at.commit.v1`, `at.identity.v1`, and `at.account.v1`
- `canonical.v1`
- tombstone, moderation/audit, media and other durable domain-event topics where applicable

These topics represent events/facts and replayable distribution, not individual retryable HTTP obligations.

## Removed historical worker implementations

The following unreferenced V6-era implementations were removed when this guide was retired:

- `fedify-sidecar/src/delivery/v6-outbound-worker.ts`
- `fedify-sidecar/src/delivery/v6-inbound-worker.ts`
- `fedify-sidecar/src/mrf/v6-mrf-runtime.ts`

They had no live construction/import on current `master` and represented obsolete migration-era assumptions. Their full source and the previous migration guide remain available in Git history for archaeology.

## Why this file remains

The path is retained as a short historical marker because older commits, notes, and developer discussions refer to `V6-MIGRATION-GUIDE.md`. Keeping a clear supersession notice is safer than leaving a detailed guide that contradicts the current architecture or deleting the path without explanation.