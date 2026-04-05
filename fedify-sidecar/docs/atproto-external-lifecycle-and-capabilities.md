# ATProto External Mode Lifecycle And Capability Spec

This document turns the external-PDS design into repo-local implementation rules for the Fedify sidecar.

## Scope

This sidecar currently has two ATProto execution modes:

- `local`: this deployment manages the DID, repo state, and signing flow.
- `external`: this deployment stores a verified binding, proxies selected XRPC routes to an external PDS, and never silently creates a local repo.

The typed policy surface lives in [AtprotoLifecyclePolicy.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/policy/AtprotoLifecyclePolicy.ts).

## Lifecycle model

The current implementation treats these as separate concerns:

- Canonical account lifecycle: `active`, `disabled`, `pending_deletion`, `deleted`
- ATProto binding lifecycle: `unlinked`, `pending_verification`, `active`, `refresh_failed`, `relink_required`, `migration_pending`, `disabled`
- Local session lifecycle: `none`, `active`, `expired`, `refreshing`, `revoked`, `compromised`

The sidecar does not persist all of these states yet, but the policy module defines the allowed transition graph now so later persistence work does not invent incompatible semantics.

## Route capabilities

The authoritative route matrix is `ROUTE_CAPABILITIES` in the policy module. Current high-value routes are:

- `com.atproto.server.createSession`: local `native`, external `proxy`
- `com.atproto.repo.createRecord`: local `native`, external `proxy`
- `com.atproto.repo.putRecord`: local `native`, external `proxy`
- `com.atproto.repo.deleteRecord`: local `native`, external `proxy`
- `com.atproto.repo.getRecord`: local `native`, external `proxy`
- `com.atproto.repo.listRecords`: local `native`, external `proxy`
- `com.atproto.repo.describeRepo`: local `native`, external `proxy`
- `com.atproto.sync.getLatestCommit`: local `native`, external `proxy`
- `com.atproto.sync.getRepo`: local `native`, external `proxy`
- `com.atproto.server.refreshSession`: local `native`, external `proxy`

## Error and response model

XRPC endpoints must keep returning ATProto-compatible `{ error, message }` bodies. That is why the runtime continues to use `XrpcErrorMapper` instead of switching public XRPC routes to RFC 9457.

Internal HTTP surfaces should use Problem Details semantics where practical:

- stable machine-readable codes
- correlation identifiers
- retryability hints
- no stack traces or secret-bearing upstream payloads

## Retry and backoff policy

External PDS calls use bounded exponential backoff with full jitter and honor `Retry-After` when present.

- transient retry conditions: timeout, transport reset, `429`, `5xx`
- non-retryable conditions: `400`, `401`, `403`, `404`, `409`, `422`, DID mismatch, repo mismatch
- upstream credentials are never logged and never returned to the client

Implementation lives in:

- [ExternalPdsClient.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/external/ExternalPdsClient.ts)
- [ExternalAtSessionStore.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/external/ExternalAtSessionStore.ts)

## Redis key design

Current external-session correlation uses:

- `at:external:session:<local-jti>`

Properties:

- values are encrypted with AES-256-GCM
- the envelope is AAD-bound to `canonicalAccountId`, `did`, and `pdsUrl`
- values carry a key version for deliberate rotation
- TTL bounded by `EXTERNAL_AT_SESSION_TTL_SECONDS`
- the local JWT `jti` remains server-side only and is not echoed to clients

Identity bindings remain in the existing identity repository keys; external metadata rides inside the binding record, not a separate secondary index.

## File layout

Current sidecar implementation surfaces are:

- Identity resolution and binding persistence:
  - [DefaultAtAccountResolver.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/auth/DefaultAtAccountResolver.ts)
  - [RedisIdentityBindingRepository.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/core-domain/identity/RedisIdentityBindingRepository.ts)
- External PDS client and secure upstream session handling:
  - [ExternalPdsClient.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/external/ExternalPdsClient.ts)
  - [ExternalAtSessionStore.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/external/ExternalAtSessionStore.ts)
  - [ExternalWriteGateway.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/external/ExternalWriteGateway.ts)
  - [ExternalReadGateway.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/external/ExternalReadGateway.ts)
- Route dispatch:
  - [AtXrpcServer.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/xrpc/AtXrpcServer.ts)
  - [AtXrpcFastifyBridge.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/xrpc/AtXrpcFastifyBridge.ts)

## Test fixtures and conformance

The current end-to-end proof for external mode is:

- [ExternalPdsModeProof.ts](/Users/damonoutlaw/mastopod-federation-architecture/fedify-sidecar/src/at-adapter/tests/ExternalPdsModeProof.ts)

It now verifies:

- external `createSession`
- external `refreshSession`
- external `createRecord`
- external `getRecord`
- external `getLatestCommit`
- external `getRepo`
- encrypted upstream session storage without leaking internal token identifiers

## Remaining work

The main remaining lifecycle/security items after this patch are:

- local refresh-session family rotation and replay detection
- circuit-breaker state per upstream PDS
- persistent binding lifecycle storage for `refresh_failed` and `relink_required`
- full `sync.getRepo` size/rate enforcement for large CAR transfers
- real third-party PDS interoperability tests in addition to the mock proof harness
