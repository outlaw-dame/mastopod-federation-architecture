# External AT DID Materialization Policy

## Purpose

Define when an external ATProto DID should be represented as a local ActivityPub actor URI for outbound AP projection.

This document separates two concerns:

1. Cross-protocol content visibility (AT and AP content can both be ingested and displayed).
2. Outbound AP projection identity requirements (AP activities require a valid AP actor URI).

## Current Behavior

- External AT DIDs are ingested from Jetstream and processed through canonical pipelines.
- AT->AP projection requires an `activityPubActorUri` for the source identity.
- If no AP actor URI binding exists, projection is skipped with `unbound_actor`.
- This is intentional and avoids auto-provisioning AP identities for arbitrary external principals.

## Recommended Default Policy

Use **Bound-Only Materialization**:

- Materialize AP actors only for identities that are:
  - local accounts managed by this deployment, or
  - explicitly onboarded into this architecture (approved bindings).
- Do not auto-materialize AP actors for all external AT DIDs.

Rationale:

- preserves identity trust boundaries,
- avoids impersonation/proxy ambiguity,
- keeps federation behavior predictable,
- still supports dual-protocol visibility for content ingestion.

## Modes

### Mode A: Bound-Only (recommended)

- Outbound AP projection: only for bound identities.
- External AT-only identities: processed and visible on AT/native surfaces; skipped for AP projection.
- Operational signal: high `unbound_actor` skip counts are expected under broad external AT traffic.

### Mode B: Selective Materialization

- Materialize AP actors for external DIDs only if explicit policy checks pass.
- Example gates:
  - allowlist by domain/tenant,
  - verified ownership challenge,
  - admin approval workflow.
- Outbound AP projection enabled only after policy acceptance.

### Mode C: Full Proxy Materialization (not recommended by default)

- Materialize AP actors for all external AT DIDs.
- Highest complexity and risk; requires strong provenance semantics and abuse controls.

## Acceptance Criteria (Product-Level)

For a local user (for example, Alice):

1. Alice has a bound AT DID and AP actor URI in identity bindings.
2. Alice content created in AT can be projected to AP.
3. Alice content created/received in AP remains visible in system views.
4. External unbound AT identities remain ingestible and visible without causing projection failures.

## Operational Metrics

Use these metrics together:

- `fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="skipped",reason="unbound_actor"}`
- `fedify_inbound_activitypub_activities_total{stage=...,activity_type=...}`
- `fedify_ap_relay_subscription_attempts_total{relay=...,status=...}`

Interpretation:

- Growing `unbound_actor` with healthy ingest metrics indicates expected Bound-Only behavior.
- Relay `follow_enqueued` with no `fetch_failed`/`backoff_skip` indicates healthy relay subscription lifecycle.

## Implementation Note

If policy changes toward selective/full materialization, implement as an explicit identity-binding workflow. Do not infer AP actor URIs from DID strings alone.
