# APDM Phase 5 — Fedify remote-authority cutover

## Purpose

Move external ActivityPub delivery authority from the transitional ActivityPods/SemApps native remote delivery path to the federation sidecar/Fedify executor after all durability, security, and interoperability gates are proven.

## Preconditions

- Phase 1 delivery contract hardening complete.
- Phase 2 interception seam complete.
- Phase 3 authoritative recipient planning complete.
- Phase 4 durable handoff complete.
- Replay idempotency horizon hardening complete.
- Execution-layer SSRF protections proven at the outbound HTTP boundary.

## Cutover invariants

- ActivityPods remains authoritative for recipient expansion and delivery planning.
- The sidecar is the only external ActivityPub HTTP executor in external mode.
- Native SemApps remote delivery remains available as a tested rollback path through stabilization and cleanup phases.
- No duplicate remote execution is allowed during coexistence testing.
- External HTTP execution is blocked unless SSRF controls are active.

## Implementation slices

### APDM-P5-A — ActivityPods authority cutover

- Add external-mode proof that native `remotePost` creation is disabled.
- Preserve rollback controls until parity gates pass.
- Validate Delivery Plan handoff remains the only external delivery input.

### APDM-P5-F — Federation executor cutover

- Verify Fedify handles all required ActivityPub flows:
  - Create/public
  - Create/unlisted
  - followers-only
  - direct mentions
  - replies
  - Follow/Accept/Undo
  - Announce
  - Like
  - Update
  - Delete
- Verify signing, retry, DLQ, shared inbox, SSRF, and remote compatibility paths.

## Exit gate

Phase 5 passes only when:

1. SemApps native `remotePost` count is zero in external mode.
2. Fedify is the sole external HTTP executor.
3. Interoperability proofs pass for supported ActivityPub flows.
4. SSRF execution-layer protections are proven.
5. Rollback remains deterministic through stabilization and cleanup phases.
6. `STATUS.md` reflects the same phase state.
