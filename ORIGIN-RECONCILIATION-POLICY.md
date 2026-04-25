# Origin Reconciliation Policy

## Purpose

Define how ActivityPods and the Fedify sidecar may re-fetch remote ActivityPub objects from their origin servers after the initial inbound delivery or thread hydration trigger.

This policy is intentionally conservative. Origin fetches are authoritative for object retrieval, but continuous polling is not the default synchronization model.

## Status

Current state:
- Event-driven origin retrieval already exists for conversation backfill in the Fedify sidecar.
- Continuous origin re-polling is not currently the default behavior.

Required policy:
- Keep event-driven origin fetch as the primary mechanism.
- Allow only tightly constrained, short-lived reconciliation polling.
- Never enable indefinite periodic polling for all remote content.

## Existing primitives to reuse

The current sidecar already provides most of the control points needed for safe reconciliation:

- Redis Streams work queues with delayed processing via `notBeforeMs`
- DLQ handling for exhausted or poison jobs
- Redis-backed idempotency and cooldown patterns
- Signed remote fetches through the shared signing client
- Retry and exponential backoff patterns already used by delivery and backfill flows

These should be reused rather than introducing a second scheduler stack.

## Definitions

- Origin object URL: the canonical remote HTTP(S) URL of the ActivityPub object being reconciled.
- Reconciliation poll: a signed fetch of an already-known remote object URL performed after initial ingestion.
- Hot thread: a remote thread with recent local reads, replies, boosts, likes, or moderation review.
- Eligible object: a remote public object that passes the rules below.

## Architecture decision

### 1. Primary model

The system must remain event-driven first.

Allowed triggers:
- Initial inbound remote activity processing
- Thread hydration or conversation backfill
- Fresh local interaction with a remote thread
- Explicit operator or moderation repair action

Disallowed primary model:
- Global timer that continuously polls all remote posts
- Background scans of all previously seen remote object URLs

### 2. Reconciliation is opt-in and decaying

If continuous re-polling is added, it must be implemented as a bounded reconciliation window, not as permanent polling.

A reconciliation window may be opened only for eligible objects, and must automatically decay to zero polling unless new local interest reactivates it.

## Eligibility rules

An object is eligible for reconciliation only if all of the following are true:

- It is remote, public, and HTTP(S)-addressable.
- It has a stable object URL already accepted by the inbound pipeline.
- It is not deleted, tombstoned, or explicitly blocked.
- It has recent local interest within the activation window.
- Its origin host is not currently circuit-broken or rate-limited.
- The object is not marked private, followers-only, direct, or otherwise non-public.

Recommended activation window:
- Up to 30 minutes after first local interaction for normal public threads.
- Up to 6 hours only for exceptional cases such as active moderation review or edit-sensitive objects.

## Scheduling model

### 1. Single-flight per object

At most one active reconciliation job may exist per origin object URL across the entire cluster.

Key:
- `origin-reconcile:claim:{sha256(originObjectUrl)}`

Behavior:
- If a worker cannot claim the object, it must not schedule another job.
- Viewers and workers must reuse the existing scheduled or in-flight job.

### 2. Delayed queue scheduling

Reconciliation jobs should be stored in the existing queue infrastructure using delayed delivery semantics.

Recommended job fields:
- `jobId`
- `originObjectUrl`
- `originHost`
- `canonicalObjectId` if known
- `reason`
- `openedAt`
- `attempt`
- `notBeforeMs`
- `lastSuccessAt`
- `lastObservedVersion`
- `windowExpiresAt`

Recommended queue:
- New dedicated queue preferred: `ap:queue:origin-reconcile:v1`
- Acceptable fallback: a dedicated stream namespace following the same Redis Streams pattern as existing workers

Do not piggyback reconciliation jobs onto inbound synthetic envelopes.

Reason:
- Reconciliation is fetch orchestration, not equivalent to inbound delivery.
- Separating it reduces duplicate processing and makes metrics and DLQ analysis clearer.

### 3. Per-origin fairness

Apply both global and per-origin budgets.

Required controls:
- Max concurrent reconciliation fetches globally
- Max concurrent reconciliation fetches per origin host
- Token-bucket or leaky-bucket budget per origin host
- Temporary host circuit breaker on repeated failures or rate limits

Recommended initial defaults:
- Global concurrency: 10
- Per-origin concurrency: 2
- Per-origin burst budget: 5 polls per 5 minutes
- Per-origin sustained budget: 30 polls per hour

## Backoff rules

Reconciliation must use exponential backoff with jitter.

Recommended delay ladder after activation:
- Poll 1: immediate or within 5 seconds of trigger
- Poll 2: 30 seconds
- Poll 3: 2 minutes
- Poll 4: 10 minutes
- Poll 5: 30 minutes
- Then stop unless reactivated

For transient failures, use full-jitter backoff:
- `delay = random(0, min(cap, base * 2^attempt))`

Recommended values:
- Base: 30 seconds
- Cap: 30 minutes

Special handling:
- HTTP 429: respect `Retry-After` if present, otherwise back off aggressively and consume host budget
- HTTP 5xx and timeouts: retry within the active reconciliation window only
- HTTP 404 or 410: treat as authoritative delete/tombstone candidate after verification rules below
- HTTP 401 or 403: stop polling unless a signed fetch configuration issue is resolved by operator action

## Stop conditions

A reconciliation window must close immediately when any of the following occurs:

- The object is tombstoned or deleted.
- The object becomes ineligible by visibility or policy.
- The reconciliation window expires.
- The maximum poll count is reached.
- The origin host enters a circuit-broken state.
- The object has had no local interest for the configured inactivity threshold.
- The object has remained stable for two consecutive successful reconciliation fetches.

Recommended limits:
- Max polls per activation window: 5
- Inactivity threshold: 15 minutes
- Stable-success threshold: 2 consecutive unchanged responses

## Freshness and merge rules

Reconciliation fetches must not blindly overwrite local state.

Required merge behavior:
- Preserve provenance of the fetch result as `reconciliation`.
- Compare the fetched object to the last accepted version.
- Only emit downstream work if a meaningful change is detected.
- Ignore semantically unchanged payloads.
- Apply idempotent merges keyed by canonical object identity plus version fingerprint.

Recommended version fingerprint inputs:
- Object URL
- `updated` if present
- `published` if present
- `content`
- `summary`
- attachments
- poll fields
- tombstone state
- edit-specific fields exposed by the remote object

If no meaningful diff is detected:
- Record success
- Advance cooldown
- Do not enqueue synthetic inbound processing

If a meaningful diff is detected:
- Enqueue one synthetic inbound reconciliation activity or equivalent internal update event
- Attach provenance metadata so downstream consumers can avoid duplicate side effects

## Delete and tombstone rules

Treat origin responses as authoritative, but not naively.

Rules:
- HTTP 410 or explicit Tombstone object: authoritative delete
- HTTP 404: treat as delete candidate only after either
  - one previous successful fetch exists for the same object, or
  - a second confirming reconciliation attempt within the same window also returns 404
- Network failure is never evidence of deletion

Delete processing must be idempotent and must not re-open polling.

## Privacy rules

Continuous polling can leak local interest patterns. Reconciliation must therefore obey the following:

- Never reconcile non-public objects.
- Never poll merely because the object exists in storage.
- Only open a reconciliation window after recent local interest or an operator action.
- Avoid attaching user-specific identifiers or audience hints to reconciliation jobs.
- Use a service actor identity for signed fetches, not end-user identities.

## Security rules

Reconciliation fetches must inherit the same remote fetch hardening used by the current backfill flow.

Required controls:
- Only HTTP and HTTPS URLs
- No credentialed URLs
- No private, loopback, or localhost targets
- No redirect following by default
- Response body size limit
- Request timeout
- Signed requests through the existing signing service

Any future relaxation of redirect handling must preserve same-origin guarantees and must never permit redirect chains into private address space.

## Idempotency model

Two layers are required.

### 1. Scheduling idempotency

Prevent duplicate jobs from being created.

Key:
- `origin-reconcile:claim:{sha256(originObjectUrl)}`

TTL:
- At least the active reconciliation window plus maximum retry cap

### 2. Change-application idempotency

Prevent duplicate downstream updates when multiple jobs observe the same remote state.

Key:
- `origin-reconcile:apply:{canonicalObjectId or originObjectUrl}:{versionFingerprint}`

TTL:
- 24 hours minimum
- 7 days preferred

If the apply key already exists:
- Ack the reconciliation job
- Record as duplicate/no-op
- Do not enqueue further work

## DLQ policy

A reconciliation job should move to DLQ only when the failure indicates poisoned input or exhausted bounded retries.

DLQ-worthy cases:
- Invalid origin URL that somehow bypassed validation
- Unsupported or malformed object payload on repeated fetches
- Repeated permanent authorization failures
- Repeated same-object processing errors after max attempts

Not DLQ-worthy by default:
- Single 5xx response
- Timeout within the active window
- One-off 429 with `Retry-After`

Recommended DLQ fields:
- `originObjectUrl`
- `originHost`
- `canonicalObjectId`
- `reason`
- `attempt`
- `lastHttpStatus`
- `lastError`
- `windowExpiresAt`

## Metrics

Add metrics before enabling reconciliation in production.

Required metrics:
- total reconciliation jobs created
- total reconciliation jobs claimed
- total reconciliation fetches attempted
- reconciliation fetch latency histogram
- reconciliation no-op count
- reconciliation changed-object count
- reconciliation delete/tombstone count
- reconciliation DLQ count
- per-origin rate-limit and circuit-breaker count

Recommended labels:
- `origin_host`
- `result`
- `reason`
- `status_family`

## Recommended rollout

### Phase 1

No continuous polling.
Keep current event-driven backfill and origin fetch only.

### Phase 2

Enable reconciliation only for hot public threads.
Use a 30-minute window, max 3 polls, strict per-origin budgets.

### Phase 3

Extend only if metrics prove value.
Do not expand to all remote content.

## Concrete default policy

If implemented now, the default policy should be:

- Reconciliation disabled by default
- Feature flag required to enable
- Public remote objects only
- Activation only on recent local thread interest
- One active window per object
- Max 5 polls per window
- Per-origin concurrency cap of 2
- Stop after 30 minutes or 2 unchanged successful fetches
- No redirects
- DLQ on malformed or permanently failing objects only

## Final recommendation

The architecture should treat origin fetch as authoritative for retrieval, but continuous re-polling should be rare, short-lived, rate-limited, and explicitly justified by current local interest.

The correct model is:
- fetch on demand
- reconcile briefly
- decay to zero
- reactivate only when new evidence or new interest appears
