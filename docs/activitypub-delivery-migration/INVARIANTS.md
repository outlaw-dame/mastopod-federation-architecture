# APDM Invariants

These invariants apply across both repositories and are stronger than phase-specific implementation details.

## Correctness

1. Every logical remote recipient represented by ActivityPub addressing semantics is either intentionally excluded by policy or included in the authoritative delivery plan.
2. `/followers` collection addressing must resolve to concrete recipients before remote handoff for ActivityPods-originated activities.
3. Local delivery must preserve current ActivityPods/SemApps inbox, LDP, dataset and side-effect semantics unless a phase explicitly proves an equivalent replacement.
4. A successful remote handoff must never depend on cancelling an already-created SemApps `remotePost` job.
5. During external mode, one subsystem owns external HTTP delivery: the federation sidecar.
6. Shared-inbox optimization may reduce HTTP POST count but must never remove logical recipients from the delivery plan.
7. Failed sharedInbox discovery falls back to a correct per-inbox path.

## Idempotency and durability

1. Delivery intents have stable identifiers derived from stable delivery semantics, not process-local state.
2. Retrying ActivityPods → sidecar handoff cannot create duplicate external delivery.
3. Sidecar restart cannot lose durably accepted intents.
4. Successful outbound targets are not redelivered merely because a different target failed.
5. Local fan-out durability work must use activity-recipient idempotency rather than whole-activity replay.
6. Automatic ActivityPods reconciliation is bounded to 48 hours, leaving a 24-hour processing allowance inside the 72-hour blind-recipient recovery-snapshot lifetime for cursor rotation, paging, refetch, and plan construction before sidecar acceptance.
7. Sidecar replay residence is bounded independently: an accepted outbox intent may age at most 48 hours before outbound work is created, and an outbound Redis Stream message may age at most 48 hours before its first completed-delivery claim check. Requeue/retry must not reset the outbox-intent clock. The original intent age is revalidated at the outbound fan-out boundary after awaited enrichment/event-log work.
8. The two sidecar age checks each permit at most five minutes of positive clock skew. The completed-delivery ledger retains successful-target markers for at least eight days. Therefore automatic producer replay (48h) + producer processing allowance (24h) + outbox-intent residence (48h) + first outbound-message residence (48h) + accepted sidecar clock skew (10m total) is at most **168 hours 10 minutes**, leaving at least a **23-hour 50-minute** safety margin before the eight-day marker floor expires.
9. Work that exceeds a bounded automatic replay/residence horizon, or whose enqueue timestamp cannot be validated, fails closed into the DLQ before an external POST; manual/operator replay outside the bounded horizon is an explicit recovery operation rather than an implicit duplicate-suppression guarantee.
10. Any defer, retry, or DLQ transition that replaces a consumed Redis Stream message must durably persist the replacement/recovery record **before** acknowledging the source message. If that write fails, the original message remains pending and reclaimable.
11. The eight-day completed-marker invariant applies across upgrades, not only to markers created by new code. Before an upgraded claim store starts claiming deliveries it incrementally extends legacy `ap:delivery:completed:*` keys whose finite TTL is below the floor, then repeats that migration every 15 minutes during mixed-version operation so short markers written by draining old workers cannot expire inside the automatic replay horizon. At least one upgraded claim-store process remains active until all old workers have drained.

## Security and authority

1. ActivityPods remains authoritative for WebID, local actor ownership, Pod dataset selection, WebACL/LDP semantics and private-key custody.
2. Private signing keys do not leave ActivityPods solely to optimize federation.
3. Local recipient delivery does not traverse an internet-facing sidecar.
4. Remote target URLs remain subject to SSRF/URL validation and domain moderation controls.
5. Contract/schema mismatches fail closed.

## Performance

1. No unbounded `Promise.all` is accepted for recipient-scale work.
2. Local and remote concurrency limits are explicit and configurable.
3. Performance claims use measured action/DB/HTTP counts. The historical ~8,000-operation figure is not treated as source-counted until instrumentation proves it.
4. SharedInbox collapse is measured by logical-recipient count versus final delivery-URL count.

## Migration safety

1. Native SemApps delivery remains a tested rollback mode until Phase 16.
2. Native remote delivery is not disabled until the sidecar can handle follower-expanded remote targets.
3. Each cross-repo phase has an exit gate; dependent work does not merge past a failed gate.
4. Runtime cutover is feature/config gated and independently reversible from data/schema migration where possible.
5. Cleanup happens after authority cutover and interoperability proof, never before.
