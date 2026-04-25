# Origin Reconciliation Design

## Scope

This document turns the higher-level policy into the concrete sidecar implementation.

Implemented pieces:
- dedicated Redis stream and DLQ for origin reconciliation jobs
- dedicated origin reconciliation worker
- opt-out feature flag that is enabled by default when Fedify runtime integration is enabled
- conservative scheduler that only opens reconciliation windows for remote conversation objects already flowing through the existing hydration path
- Prometheus metrics for reconciliation outcomes and host backoff

## Trigger model

The feature is not a global crawler.

Current trigger:
- inbound public note-like activity enters the inbound worker
- the same activity path that triggers replies backfill also calls the origin reconciliation scheduler
- scheduler only opens a reconciliation window when the object advertises conversation hydration signals such as `replies`, `context`, or `contextHistory`

This keeps the feature bounded to active conversation-shaped remote objects.

## Queue model

New queue:
- `ap:queue:origin-reconcile:v1`

New DLQ:
- `ap:queue:dlq:origin-reconcile:v1`

Job fields:
- `originObjectUrl`
- `canonicalObjectId`
- `actorUriHint`
- `reason`
- `attempt`
- `maxAttempts`
- `notBeforeMs`
- `windowExpiresAt`
- `lastFingerprint`
- `unchangedSuccesses`
- `notFoundCount`

## Idempotency model

Scheduling idempotency:
- `ap:origin-reconcile:claim:{originObjectUrl}`
- prevents multiple active windows for the same object URL

Apply idempotency:
- `ap:origin-reconcile:apply:{objectKey}:{fingerprint}`
- prevents duplicate synthetic updates when multiple polls observe the same changed state

## Worker behavior

The worker:
- respects `notBeforeMs`
- enforces per-origin rate limit and per-origin concurrency via the existing queue primitives
- fetches the origin object directly with signed GET requests
- compares the fetched payload fingerprint with the last known fingerprint
- enqueues synthetic inbound `Update` activities when the remote object changed
- stops after two unchanged successful fetches or when the reconciliation window expires

## Safety controls

Remote fetch rules:
- only HTTP(S)
- no credentialed URLs
- no localhost or private IP literals
- no redirects
- bounded response body size
- bounded request timeout

## Default enablement

Feature flag:
- `ENABLE_ORIGIN_RECONCILIATION`

Default:
- enabled unless explicitly set to `false`, but only when `ENABLE_FEDIFY_RUNTIME_INTEGRATION=true`

## Current tradeoffs

Deliberate conservative choices in this implementation:
- scheduling is limited to conversation-shaped remote notes, not all remote objects
- explicit tombstone handling is supported only when the origin returns an object payload, not inferred solely from 404s
- a repeated 404 stops the window but does not force a synthetic delete unless a future implementation adds stronger deletion provenance