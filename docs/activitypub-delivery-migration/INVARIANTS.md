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
