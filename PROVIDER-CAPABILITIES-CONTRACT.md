# Provider Capabilities Contract (v1)

## Purpose

Define a single discovery contract that allows apps to adapt to provider-enabled features across ActivityPub-first and optional ATProto modes.

This contract explicitly supports AP-only providers.

## Implementation Artifacts

Concrete implementation assets for this contract are in:

- `fedify-sidecar/docs/provider-capabilities/README.md`
- `fedify-sidecar/docs/provider-capabilities/provider-capabilities.schema.v1.json`
- `fedify-sidecar/docs/provider-capabilities/example.ap-core.v1.json`
- `fedify-sidecar/docs/provider-capabilities/example.ap-scale.v1.json`
- `fedify-sidecar/docs/provider-capabilities/example.dual-protocol-standard.v1.json`
- `fedify-sidecar/docs/provider-capabilities/startup-validation-matrix.md`
- `fedify-sidecar/docs/provider-capabilities/enforcement-patterns.md`

## Endpoint

- Public discovery endpoint:
  - `GET /.well-known/provider-capabilities`
- Content type:
  - `application/vnd.activitypods.provider-capabilities+json;version=1`

## Compatibility Rule

Clients MUST rely on this endpoint as the source of truth for feature availability.
Clients MUST NOT infer capability support from the mere existence of unrelated routes.

## Top-Level Response Shape

```json
{
  "schemaVersion": "1.0.0",
  "provider": {
    "id": "pods.example",
    "displayName": "Example Pods",
    "region": "us-east-1"
  },
  "profiles": {
    "active": ["ap-scale"],
    "supported": ["ap-core", "ap-scale", "dual-protocol-standard"]
  },
  "protocols": {
    "activitypub": {
      "enabled": true,
      "version": "1.0",
      "status": "enabled"
    },
    "atproto": {
      "enabled": false,
      "status": "disabled",
      "disabledReason": "provider_policy"
    }
  },
  "capabilities": [
    {
      "id": "provider.account.provisioning",
      "version": "1.0.0",
      "status": "enabled",
      "dependencies": [],
      "limits": {
        "approvedAppsRequired": true,
        "requiresUserVerification": true,
        "maxAccountsPerAppPerDay": 250,
        "supportedProtocolSet": "solid,activitypub,atproto"
      }
    },
    {
      "id": "ap.federation.ingress",
      "version": "1.0.0",
      "status": "enabled",
      "dependencies": [],
      "limits": {
        "maxPayloadBytes": 1048576,
        "requestsPerMinute": 1200
      }
    },
    {
      "id": "ap.firehose",
      "version": "1.0.0",
      "status": "enabled",
      "dependencies": ["ap.streams"],
      "limits": {
        "retentionDays": 30,
        "replayWindowHours": 72
      }
    },
    {
      "id": "at.identity.binding",
      "version": "1.0.0",
      "status": "disabled",
      "dependencies": ["protocol.atproto"],
      "disabledReason": "profile_not_active"
    }
  ],
  "entitlements": {
    "plan": "pro",
    "effectiveAt": "2026-04-10T00:00:00Z",
    "overrides": [
      {
        "capabilityId": "ap.firehose",
        "type": "limit",
        "field": "retentionDays",
        "value": 60
      }
    ]
  },
  "degradation": {
    "modes": [
      {
        "when": "opensearch.disabled",
        "behavior": "feeds_limited",
        "contractRef": "feed-limited-v1"
      }
    ]
  },
  "events": {
    "catalogVersion": "1.0.0",
    "topics": [
      {
        "name": "ap.stream1.local-public.v1",
        "schema": "activity-stream-event-v1",
        "retentionDays": 30,
        "replay": true
      },
      {
        "name": "ap.stream2.remote-public.v1",
        "schema": "activity-stream-event-v1",
        "retentionDays": 30,
        "replay": true
      }
    ]
  },
  "security": {
    "internalApisAuth": "bearer",
    "signingKeysLocation": "activitypods-only",
    "failClosed": true
  }
}
```

## Capability Status Values

- `enabled`: available for use
- `disabled`: not available
- `beta`: available with beta guarantees
- `deprecated`: available but scheduled for removal

## Standard Capability IDs (Initial Set)

### Provider / Account Lifecycle

- `provider.account.provisioning`

### ActivityPub Core/Scale

- `ap.federation.ingress`
- `ap.federation.egress`
- `ap.signing.batch`
- `ap.queue.delivery`
- `ap.streams`
- `ap.firehose`
- `ap.search.opensearch`
- `ap.mrf`
- `ap.media.pipeline`
- `ap.notifications.durable`

### ATProto Optional

- `at.identity.binding`
- `at.handle.validation`
- `at.repo.registry`
- `at.xrpc.server`
- `at.xrpc.repo`
- `at.sync.firehose`

## Provider Profiles

Profiles are convenience bundles. Providers may customize, but MUST emit effective capabilities explicitly.

### `ap-core` (AP-only minimum scalable federation)

Enabled:

- `ap.federation.ingress`
- `ap.federation.egress`
- `ap.signing.batch`
- `ap.queue.delivery`

Disabled:

- `at.*`

Provider-specific account provisioning may be enabled or disabled independently
of ATProto support. Apps MUST check `provider.account.provisioning` rather than
assuming provider-hosted signup is available through app surfaces.

### `ap-scale` (AP-only advanced)

Enabled:

- all `ap-core` capabilities
- `ap.streams`
- `ap.firehose`
- `ap.search.opensearch` (optional but recommended)
- `ap.mrf`

Disabled:

- `at.*`

### `dual-protocol-standard`

Enabled:

- all `ap-scale` capabilities
- selected `at.*` capabilities for identity/repo/XRPC
- `provider.account.provisioning` when the provider permits approved apps to
  create accounts and pods on behalf of users

## Error Contract for Disabled Features

If a client calls a disabled capability route, return deterministic error payload:

```json
{
  "error": "feature_disabled",
  "message": "Capability at.xrpc.repo is disabled for this provider profile",
  "capabilityId": "at.xrpc.repo",
  "providerProfile": "ap-scale",
  "retryable": false
}
```

Suggested status codes:

- `403` for policy/entitlement denial
- `404` only when route intentionally hidden; if hidden, discovery endpoint still must declare status

## Entitlement Enforcement Requirements

Enforcement must occur in:

1. HTTP request path
2. Background worker path
3. Event subscription authorization path

A UI-only entitlement check is non-compliant.

## Startup Validation Requirements

Runtime MUST fail startup if enabled capabilities violate dependency requirements.

Example invalid combination:

- `ap.firehose = enabled`
- `ap.streams = disabled`

Expected behavior: fail fast with config error before serving traffic.

## Caching and Freshness

- Responses SHOULD include `ETag` and `Cache-Control: max-age=60`.
- Clients SHOULD refresh on 304 or every 60 seconds for admin/ops surfaces.
- Critical entitlement changes SHOULD trigger cache busting.

## Security

- Public-safe capability metadata may be anonymously readable.
- Plan/internal limits may be scoped by authenticated tenant/admin token.
- No secrets, credentials, or private topology details in public response.

## Conformance Tests

A provider implementation is conformant when tests verify:

1. AP-only profile returns all `at.*` capabilities as disabled.
2. Disabled feature calls return `feature_disabled` contract.
3. Entitlement overrides are reflected in effective limits.
4. Invalid dependency combinations fail startup.
5. Event catalog entries include schema + retention + replay metadata.
