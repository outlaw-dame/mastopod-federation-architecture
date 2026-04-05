# Protocol Bridge

This module implements the first canonical protocol-bridge slice for `fedify-sidecar`.

The design follows:

`protocol input -> canonical intent -> policy -> protocol projector -> native write path`

What is included here:

- canonical semantic model for intent, content, addressing, provenance, and warnings
- translator and projector registries
- ActivityPub `Create(Note)` and `Create(Article)` translators
- ActivityPub `Update(Note|Article)`, `Delete(Note|Article)`, and `Update(Person)` translators
- ActivityPub `Like`, `Announce`, `Follow`, and `Undo` translators for canonical social add/remove intents
- ATProto `app.bsky.feed.post` translators for direct envelopes and `at.ingress.v1` commit events
- ATProto `app.bsky.feed.post` delete translators for persisted `at.commit.v1` delete envelopes
- ATProto `app.bsky.actor.profile` profile-update translators for direct envelopes and persisted commit events
- ATProto `app.bsky.feed.like`, `app.bsky.feed.repost`, and `app.bsky.graph.follow` translators for direct envelopes plus persisted delete envelopes enriched from `at.commit.v1`
- ATProto `site.standard.document` translators for direct envelopes and persisted `at.commit.v1` operations
- `PostCreate`, `PostEdit`, `PostDelete`, and `ProfileUpdate` projectors for ActivityPub and ATProto, including longform article projection to `site.standard.document` plus a feed teaser
- social-action projectors for `like`, `repost`, and `follow` add/remove flows in both directions
- video parity across protocols:
  - ATProto `app.bsky.embed.video` and `app.bsky.embed.recordWithMedia` video payloads now translate into canonical video attachments with blob-backed public URLs when available
  - canonical video attachments now project back to ActivityPub as first-class `Video` attachments
  - ActivityPub video attachments now project to AT through explicit attachment media hints, a trusted internal media-resolution endpoint, and native AT blob uploads before commit
  - native AT `createRecord` / `putRecord` post writes now preserve video embeds through the canonical write path instead of reserializing them away
  - the legacy native canonical AT post serializer now also emits `app.bsky.embed.video` directly, and it prefers a single video embed over image galleries to match ATProto's single-media-embed constraint
  - local native AT post writes now register trusted per-post media descriptors backed by existing AT blob refs, so later canonical post events can rebuild video/image embeds without bridge hints, remote fetches, or duplicate blob uploads
  - native local post-media descriptor state is now pruned on post update and deleted on post delete, so blob-reference metadata does not linger longer than necessary
- local longform parity on the AT-native path:
  - local `site.standard.document` writes now generate, update, and delete a deterministic companion `app.bsky.feed.post` teaser in the same native commit path
  - the local article teaser uses the same deterministic teaser rkey scheme as mirrored bridge articles, so longform parity stays stable across native and mirrored flows
  - teaser generation is local-only; bridged article commands still keep explicit control of their own teaser records and do not double-create companions
  - local article and teaser alias records now also retire with the logical post delete timestamp after native deletes, matching the social-delete lifecycle path
- article link-preview parity across protocols:
  - ActivityPub `Article` translation now populates canonical link previews from the article URL
  - AT teaser posts now emit `app.bsky.embed.external` for mirrored articles on both create and update
  - the AT bridge write adapter can now upload preview thumbnails as native blob refs for external-card embeds, falling back to text-only cards if thumbnail resolution fails
  - ActivityPub `Article` projection now exposes preview thumbnails via `icon` when a canonical preview image exists
- note link-preview parity across protocols:
  - ActivityPub `Note` translation now promotes the first explicit link facet into canonical link preview metadata
  - mirrored note posts on the AT side now carry the same external-card thumbnail blob treatment as mirrored articles
  - ActivityPub note projection now supports policy-driven output for link previews:
    - `attachment_only` (default, Mastodon-safe): emit a standards-aligned `Document` card on `attachment`
    - `attachment_and_preview` (richer AP mode): emit the same card on both `attachment` and `preview`
    - `disabled`: omit AP-side note preview cards entirely
  - runtime policy is controlled by `PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_MODE`
  - outbound delivery can now tailor note preview shape per target domain by carrying explicit internal preview URL hints and applying them at the final publish/enqueue step:
    - `PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_RICH_DOMAINS`: domains that should receive `attachment_and_preview`
    - `PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_DISABLED_DOMAINS`: domains that should receive `disabled`
    - precedence is `disabled` > `rich` > default mode
- projection ledger implementations for in-memory and Redis-backed loop prevention
- AP->AT and AT->AP workers with transient-only full-jitter exponential backoff
- concrete runtime adapters for:
  - publishing bridge ingress events to `ap.atproto-ingress.v1`
  - resolving outbound ActivityPub recipients through a trusted internal ActivityPods authority before publishing `ap.outbound.v1`
  - routing projected AT commands through the existing native `DefaultAtWriteGateway`
  - publishing native AT event topics through a real RedPanda-backed `EventPublisher`
  - consuming `ap.stream1.local-public.v1`, `at.commit.v1`, verified `at.ingress.v1`, and `ap.atproto-ingress.v1`
  - fanning out local `at.commit.v1`, `at.identity.v1`, and `at.account.v1` into the hosted-PDS `subscribeRepos` stream through a Redis-backed firehose cursor store and a dedicated local firehose runtime
  - enforcing strict AT firehose wire compatibility by encoding hosted `subscribeRepos` frames as concatenated DRISL-CBOR header/payload maps and treating malformed external frames as connection-level errors that trigger replay-safe reconnects
  - verifying external AT `#commit` frames with a production verifier that checks the signed commit block against the DID signing key, validates the CAR slice, and proves advertised ops by inverting them over the current MST root back to `prevData`
  - resolving external AT identity changes against authoritative DID documents and independently re-confirming handles before trusting them
  - rebuilding repo-head sync state from authenticated `com.atproto.sync.getRepo` exports plus `com.atproto.sync.getLatestCommit`, including CAR-root validation against the latest commit CID
  - validating external AT firehose source configuration through a dedicated bootstrap helper, with deterministic source IDs and explicit fail-closed runtime gating whenever a verifier is not supplied
  - forwarding mirrored AT->AP activities into a trusted internal ActivityPods endpoint
  - resolving ActivityPub `Undo` activity references through a trusted internal ActivityPods endpoint when the original social activity is not embedded inline
  - projecting profile avatar/banner media across protocols via explicit canonical attachment roles, a trusted internal ActivityPods raster-image fetch endpoint, native AT blob uploads, and public `com.atproto.sync.getBlob` URLs for ActivityPub consumers
  - preserving bridge provenance through the native AT commit path so mirrored create/update/delete writes do not loop back
  - enriching persisted `at.commit.v1` delete ops with subject strong refs so AT delete events can translate back into canonical removals without heuristics
  - resolving bridged AT `putRecord` post/article mutations into canonical update events instead of treating them as creates
  - preserving explicit bridged AT record locators (`collection` + `rkey`) through the native write path so mirrored create/update/delete flows remain stable even when alias state is missing
  - deriving longform teaser AT coordinates from the persisted article record key so teaser update/delete parity survives teaser-alias loss
  - preserving explicit bridged longform teaser canonical IDs through native `putRecord` upserts so article teaser updates recover even when the teaser alias was never persisted
  - preserving canonical article URLs in native AT alias state so AT-origin longform create/update/delete flows keep a stable ActivityPub object ID even when later events omit `record.url`
  - routing `site.standard.document` delete envelopes through the article translator instead of the generic Bluesky post-delete path
  - rejecting obvious loopback/private literal OpenGraph preview targets by default to reduce SSRF exposure during link-preview fetches

What is intentionally still guarded:

- broader native TypeScript hygiene outside the protocol-bridge-focused compilation target
- external raw AT firehose intake is still guarded at bootstrap time until a production `AtCommitVerifier` is wired into `index.ts`; the bootstrap now validates `AT_EXTERNAL_FIREHOSE_SOURCES` plus source IDs and is ready to assemble the runtime once commit verification exists, but live upstream commit trust would still be misleading without authenticated commit verification

The remaining guarded gaps are intentional:

1. `ap.outbound.v1` now resolves recipients through a trusted internal ActivityPods endpoint and publishes one delivery-readiness event per target domain so the downstream outbound worker can apply per-domain rate limits safely.
2. ActivityPub `Undo` resolution now also stays on authenticated internal routes by using a dedicated companion ActivityPods resolver service, rather than letting the sidecar fetch arbitrary remote activity IDs directly.
3. The trusted AT->AP receiver and outbound resolver both depend on the companion ActivityPods integration services under `activitypods-integration/` so mirrored activities stay on authenticated internal routes instead of public write surfaces.
