# Pluggable + Subscribable Readiness Scorecard

## Scope

This scorecard evaluates whether the current architecture is ready for provider-electable service composition where:

- providers may run ActivityPub-only,
- providers may optionally add ATProto,
- apps can adapt automatically to the provider's enabled capabilities.

The goal is to avoid forcing dual AP+AT support while preserving scale and advanced options.

## Scoring Method

- Scale: 0-5 (0 = missing, 5 = production-ready)
- Weighted score = (score / 5) * weight
- Total possible = 100

## Dimension Scores (Current)

| Dimension | Weight | Score | Weighted | Status |
|---|---:|---:|---:|---|
| Capability discovery contract | 20 | 2 | 8.0 | Yellow |
| Entitlement/subscription enforcement | 15 | 1 | 3.0 | Red |
| Dependency + degradation validation | 15 | 2 | 6.0 | Yellow |
| Versioned service contracts | 10 | 3 | 6.0 | Yellow |
| Event subscription + schema governance | 15 | 2 | 6.0 | Yellow |
| Tenant isolation + blast radius controls | 10 | 3 | 6.0 | Yellow |
| Observability by capability | 10 | 3 | 6.0 | Yellow |
| Security + compliance boundaries | 5 | 4 | 4.0 | Green |
| **Total** | **100** |  | **45.0 / 100** | **Yellow-Red transition** |

## Evidence Snapshot

Strong today:

- Provider-electable tier model is explicit.
- Optional worker/runtime modules are feature-flagged.
- Internal trust boundaries are clear (signing, inbound verification).
- Route capability matrix exists for AT external mode.

Gaps that keep score below 60:

- No cross-protocol provider capability endpoint for app bootstrap.
- No first-class plan/entitlement model consistently enforced in API + workers.
- No startup dependency DAG validation for capability combinations.
- Event schema governance and subscriber contract lifecycle not yet fully unified.

## AP-Only Provider Readiness

### Verdict

**Supported conceptually, partially productized operationally.**

Why:

- The architecture already separates AP scalability features from AT-specific identity/repo flows.
- AP scaling primitives (queues, streams, retries, indexing, moderation lanes) are independently useful.
- But providers/apps still need explicit capability discovery and entitlement contracts to make AP-only operation predictable at runtime.

### What AP-Only Must Be Able To Do

1. Run AP federation and delivery at scale.
2. Enable optional AP modules (OpenSearch, media pipeline, relay ingestion) without enabling AT.
3. Expose capability metadata so apps never assume AT endpoints exist.
4. Return deterministic error contracts for AT calls when AT is disabled.

## Required Readiness Gates

### Gate A (must pass first)

- Provider capability endpoint published (`/.well-known/provider-capabilities`).
- AP-only profile officially defined and tested.
- AT routes either absent or deny with stable contract (`feature_disabled`).

### Gate B

- Entitlement resolver integrated in request path + worker path.
- Capability dependency validation at startup.

### Gate C

- Event catalog with schema versions + retention + replay guarantees.
- Capability-scoped SLO dashboards and alerts.

## Recommended Provider Profiles

### Profile: `ap-core`

- AP federation ingress/egress
- signing API
- queue + retry + idempotency
- no AT endpoints

### Profile: `ap-scale`

- `ap-core` plus:
  - stream1/stream2/firehose
  - OpenSearch indexing
  - relay ingestion and moderation lanes

### Profile: `dual-protocol-standard`

- `ap-scale` plus:
  - AT identity binding
  - AT repo and XRPC routes
  - cross-protocol link verification

## 30-Day Target Score

Target >= 75/100 by completing:

1. Capability endpoint and schema (adds +10 to +14 points).
2. Entitlement enforcement (adds +8 to +12 points).
3. Startup dependency validation and degradation contracts (adds +6 to +10 points).
4. Event governance artifacts (adds +6 to +10 points).

## Exit Criteria

You can claim "pluggable + subscribable aligned" when:

1. AP-only providers can run all AP scale features with no AT dependency.
2. Apps auto-adapt from capability discovery without probing failures.
3. Plan entitlements are enforced consistently in APIs, workers, and streams.
4. Capability combinations are validated pre-runtime with deterministic degradation behavior.
