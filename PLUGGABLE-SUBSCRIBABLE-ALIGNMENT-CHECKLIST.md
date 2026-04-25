# Pluggable + Subscribable Architecture Alignment Checklist

## Purpose

Use this checklist to verify that providers can elect services and apps can adapt at runtime without hidden coupling.

## Current Baseline

The current architecture already establishes strong foundations:

- Tiered provider-electable model (Core, Tier 2, Tier 3)
- Feature-flagged sidecar capabilities
- Versioned event topics and internal contracts
- Clear trust boundaries (signing and inbound verification)

These are necessary for pluggability, but not sufficient for provider/app subscription-grade alignment.

## Alignment Dimensions

### 1) Capability Discovery Contract (Provider -> App)

Goal: apps should discover enabled services at runtime, not infer from failures.

Required:

- A canonical capability document endpoint (for example: /.well-known/provider-capabilities)
- Capability entries include:
  - capability name (stable identifier)
  - version (semver)
  - status (enabled, disabled, deprecated, beta)
  - dependencies (other capabilities required)
  - limits (rate, payload size, retention)
- Signed or authenticated delivery for non-public capability details

Pass criteria:

- Any app can bootstrap behavior from one endpoint call
- No capability detection logic requires trial-and-error requests

### 2) Entitlement / Subscription Model

Goal: provider plans map to technical entitlements in a deterministic way.

Required:

- Plan-to-capability mapping table (Basic, Pro, Enterprise, custom)
- Tenant-level overrides (enable, disable, quota adjustments)
- Enforcer in request path and worker path (not just UI-level checks)
- Contracted error codes for entitlement denials

Pass criteria:

- Same plan yields identical behavior across API, workers, and events
- Disabled capabilities fail closed with explicit denial reason

### 3) Dependency and Degradation Rules

Goal: disabling one module should degrade predictably.

Required:

- Capability dependency DAG
- Runtime startup validation that rejects invalid capability combinations
- Fallback behavior defined for each optional module
  - example: no OpenSearch -> feed endpoints return limited mode contract

Pass criteria:

- Invalid combinations are blocked at startup, not discovered in production
- Degradation mode is observable and documented per endpoint

### 4) Versioned Service Contracts

Goal: optional modules can evolve independently without breaking apps.

Required:

- Semver policy for each internal/public contract
- Backward-compat window per contract
- Deprecation metadata in capability document
- Contract tests for all supported versions

Pass criteria:

- Apps can negotiate or pin supported versions
- Provider upgrades do not silently break older app builds

### 5) Event Subscriptions and Schema Governance

Goal: subscribers can reliably consume only the streams they opt into.

Required:

- Event catalog with schema versions and ownership
- Explicit subscribe authorization model by tenant and app
- Replay and retention guarantees per stream
- DLQ semantics documented per stream

Pass criteria:

- A consumer can subscribe with deterministic schema + retention expectations
- Schema changes are compatible or version-bumped, never silent

### 6) Tenant Isolation and Blast-Radius Control

Goal: one tenant's module choices do not destabilize others.

Required:

- Isolation strategy for queues, consumer groups, and rate-limits
- Per-tenant quotas and circuit breakers
- No shared mutable state without tenant partition keys

Pass criteria:

- Overload or misconfiguration in one tenant does not cascade globally

### 7) Observability by Capability

Goal: operational teams can measure capability health independently.

Required:

- Metrics tagged by capability and tenant
- SLOs per capability (latency, error rate, backlog)
- Health endpoint surfaces capability-level readiness
- Alert rules per optional module

Pass criteria:

- A provider can disable one capability safely and verify impact immediately

### 8) Compliance and Security Boundaries

Goal: optional services preserve trust boundaries under all combinations.

Required:

- Security model per capability (authn/authz, secrets, key ownership)
- Fail-closed policy for internal endpoints
- Audit events for entitlement changes and capability toggles

Pass criteria:

- Capability toggles are auditable and security posture does not regress

## Practical Gap Snapshot Against Current Design

Likely already strong:

- Core modular separation (queues vs logs vs index)
- Worker feature flags
- Internal API boundaries and contract hardening
- Route capability matrix for ATProto external mode

Still needs to be explicit to be fully subscription-grade:

- Cross-protocol provider capability discovery endpoint
- First-class entitlement model (plan -> capability -> enforced limit)
- Dependency DAG validation and published degradation behavior
- Unified event schema governance with subscriber contract lifecycle

## 30-Day Closure Plan

1. Define and ship provider capability document schema and endpoint.
2. Implement plan/entitlement resolver and enforce in API + workers.
3. Add startup dependency validator for capability combinations.
4. Publish stream catalog with versioning and retention contracts.
5. Add capability-scoped SLO dashboards and alerts.
6. Add contract tests for capability negotiation and degradation modes.

## Exit Condition

Architecture is considered aligned when a provider can select any valid capability set, an app can discover and adapt to that set automatically, and behavior remains deterministic, observable, and contract-safe across API, workers, and streams.
