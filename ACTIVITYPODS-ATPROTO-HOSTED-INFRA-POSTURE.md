# ActivityPods ATProto Hosted Infrastructure Posture

## Default posture

ActivityPods apps should not require a full ATProto Relay, full-network firehose verifier, or AppView for default operation.

The default integration profile is Bluesky-hosted, app-local indexing:

- use Bluesky AppView APIs for canonical `app.bsky.*` reads and hydration;
- use the user's PDS for authenticated writes and account-scoped operations;
- use Jetstream only as a filtered event source for app-local candidate discovery, ranking hints, cache invalidation, and cross-protocol projection;
- store only app-owned state, local cache rows, and explicit cross-protocol projections;
- deduplicate AT content by AT URI before persistence and before rendering feed responses.

This keeps experiments, MVPs, and small rollouts low-cost while preserving a migration path to more independent infrastructure when product requirements justify it.

## Integration profiles

### 1. Bluesky-compatible client

Use this for experiments, small apps, and first launches.

- Reads: `https://public.api.bsky.app` or `https://api.bsky.app`.
- Writes: the user's PDS, commonly discovered through `https://bsky.social` for Bluesky-hosted accounts.
- Local storage: preferences, app state, bookmarks, rankings, and short-lived cache.
- Do not run: full Relay, AppView, or unbounded firehose ingestion.

### 2. Thin index / feed generator

Use this when the app needs custom discovery or ranking.

- Consume Jetstream with bounded `wantedCollections` or `wantedDids` filters.
- Store post AT URIs plus minimal metadata needed for ranking.
- Return feed skeletons where possible and let Bluesky AppView hydrate post/profile/thread views.
- Treat Jetstream as an event hint source, not as canonical truth.

### 3. Partial AppView

Use this only when the app owns lexicons or views that Bluesky AppView cannot provide.

- Index selected lexicons, communities, or app-owned records.
- Keep explicit retention, cursor, backfill, moderation, and delete/takedown policies.
- Avoid pretending this is a full-network AppView.

### 4. Independent AT stack

Use this only for scale, governance, data-independence, or protocol reasons.

- Requires production commit verification, backfill, indexing, hydration, graph/thread/count semantics, moderation state, and operational monitoring.
- This profile is intentionally not the default for ActivityPods apps.

## Safety rules

- Never enable unbounded Jetstream intake by default.
- Never run Jetstream and full relay ingestion for the same app purpose without a written dedupe/source-of-truth policy.
- Canonical AT dedupe key is the AT URI.
- Bluesky AppView is the source of truth for `app.bsky.*` hydrated reads in the default profiles.
- Local rows are cache/projection rows and may be refreshed or repaired from Bluesky AppView/PDS state.
- All outbound hosted-service calls must use HTTPS, explicit allowlisted hosts, bounded timeouts, bounded retries, and jittered exponential backoff.

## Memory app application

Memory uses the thin index profile:

- local tables cache AT records, feed candidates, and identity profile snapshots;
- `public.api.bsky.app` hydrates profile fields when local rows only contain DIDs;
- Jetstream defaults to filtered `app.bsky.feed.post` and `app.bsky.actor.profile` events;
- feed responses deduplicate by canonical URI before paging;
- XRPC feed skeleton responses return AT URIs and rely on Bluesky AppView hydration.
