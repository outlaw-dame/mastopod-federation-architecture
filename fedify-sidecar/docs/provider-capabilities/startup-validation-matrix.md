# Capability Startup Validation Matrix

This matrix defines required startup validation for capability combinations.

Goal: fail fast before serving traffic when provider configuration is inconsistent.

## Evaluation Rules

1. Build effective capability set from:
   - profile defaults
   - plan entitlements
   - tenant/provider overrides
2. Validate dependency graph.
3. Validate protocol gates.
4. Validate required infrastructure and env vars for enabled capabilities.
5. Abort startup on any `fatal` rule violation.

## Core Dependency Rules

| Rule ID | If Enabled | Requires | Severity | Error Code |
|---|---|---|---|---|
| DEP-001 | `ap.federation.egress` | `ap.signing.batch`, `ap.queue.delivery` | fatal | `cap_dependency_missing` |
| DEP-002 | `ap.firehose` | `ap.streams` | fatal | `cap_dependency_missing` |
| DEP-003 | `ap.search.opensearch` | `ap.firehose` | fatal | `cap_dependency_missing` |
| DEP-004 | `at.identity.binding` | `protocol.atproto` | fatal | `cap_protocol_disabled` |
| DEP-005 | `at.xrpc.server` | `protocol.atproto` | fatal | `cap_protocol_disabled` |
| DEP-006 | `at.xrpc.repo` | `protocol.atproto`, `at.identity.binding` | fatal | `cap_dependency_missing` |

## Infrastructure Rules

| Rule ID | If Enabled | Requires Infra/Config | Severity | Error Code |
|---|---|---|---|---|
| INF-001 | `ap.queue.delivery` | Redis URL + queue keys configured | fatal | `cap_infra_missing` |
| INF-002 | `ap.streams` | RedPanda brokers + stream topics configured | fatal | `cap_infra_missing` |
| INF-003 | `ap.search.opensearch` | OpenSearch URL + auth (if required) | fatal | `cap_infra_missing` |
| INF-004 | `ap.signing.batch` | ActivityPods signing endpoint + token | fatal | `cap_infra_missing` |
| INF-005 | `ap.mrf` | MRF policy module load succeeds | fatal | `cap_module_load_failed` |
| INF-006 | `provider.account.provisioning` | account orchestrator, approved-app registry, user verification provider, idempotency store | fatal | `cap_infra_missing` |

## AP-Only Profile Rules

| Rule ID | Profile | Rule | Severity | Error Code |
|---|---|---|---|---|
| APO-001 | `ap-core` / `ap-scale` | all `at.*` must be `disabled` | fatal | `cap_profile_mismatch` |
| APO-002 | `ap-core` / `ap-scale` | `protocol.atproto.enabled` must be false | fatal | `cap_profile_mismatch` |
| APO-003 | `ap-core` / `ap-scale` | disabled AT routes must emit `feature_disabled` when called | warning at startup, fatal in conformance tests | `cap_contract_missing` |

## Allowed Degradation Rules

These are valid and should not fail startup when contractually declared in discovery output.

| Degradation ID | Condition | Allowed Behavior |
|---|---|---|
| DEG-001 | `ap.search.opensearch` disabled | feed endpoints switch to limited-mode contract (`feed-limited-v1`) |
| DEG-002 | `ap.media.pipeline` disabled | attachments pass through original URLs without derived media variants |
| DEG-003 | `ap.notifications.durable` disabled | fallback to best-effort notifications with explicit client-visible mode flag |

## Invalid Combination Examples

1. `ap.firehose=enabled` and `ap.streams=disabled`
2. `ap.search.opensearch=enabled` and `ap.firehose=disabled`
3. `at.xrpc.repo=enabled` while `protocol.atproto.enabled=false`
4. `ap.federation.egress=enabled` and `ap.signing.batch=disabled`

All examples above MUST fail startup.

## Suggested Startup Validator Interface

```ts
export interface StartupValidationIssue {
  severity: 'warning' | 'fatal';
  ruleId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface StartupValidationResult {
  ok: boolean;
  issues: StartupValidationIssue[];
}

export function validateCapabilityConfig(): StartupValidationResult;
```

## Suggested Failure Behavior

- Log all issues with structured fields (`ruleId`, `code`, `capabilityId`).
- Exit process with non-zero code if any `fatal` issue is present.
- Emit a startup summary metric tagged by profile and result.
