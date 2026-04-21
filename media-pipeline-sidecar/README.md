# Media Pipeline Sidecar

Focused media infrastructure service for the Mastopod federation architecture.

## Responsibilities

- secure remote media ingress
- MIME and file validation
- media transformation and derivative generation
- S3-compatible canonical storage (Filebase, AWS S3, MinIO, R2, B2 S3 API)
- Cloudflare delivery URL generation
- raw safety signal collection adapters
- optional PDQ perceptual-hash collection for provider-managed blocked-image matching
- protocol-specific media projection helpers
- media lifecycle events and indexing payloads

## Non-responsibilities

- final moderation decisions
- feed filtering or ranking policy
- user safety preferences
- human moderation workflow

## Runtime shape

```text
queue ingress -> ingest worker -> fetch worker -> process:image|video -> video:rendition -> finalize worker
```

The finalize stage persists the canonical asset, emits a media lifecycle event, and writes a media indexing payload. Any safety signals are emitted as raw signals only for downstream MRF evaluation.

PDQ note:
- When `PDQ_HASH_SERVICE_BASE_URL` is configured, the image worker calls a PieFed-compatible PDQ service after canonical upload.
- The service is expected to return `pdq_hash_binary` plus `quality`.
- The media pipeline still does not block anything directly; it only emits the hash as a raw signal so `fedify-sidecar` can apply provider policy.

Important deployment note:
- `npm start` only runs the HTTP ingress service.
- Production deployments must also run the queue workers for `ingest`, `fetch`, `process:image`, `process:video`, `video:rendition`, and `finalize`.
- The `fedify-sidecar/docker-compose.yml` stack models ingress and workers as separate services so each stage can be scaled independently.

## Architecture integration

To wire this into the broader Mastopod stack:

1. Deploy `media-pipeline-sidecar` alongside Redis and OpenSearch.
2. Add `fedify-sidecar/activitypods-integration/media-pipeline-emitter.service.js` to the ActivityPods backend so local pod file resources are forwarded to `POST /internal/media/ingest`.
3. Share the same Redis and RedPanda/OpenSearch infrastructure already used by the sidecar stack when you want asset persistence, lifecycle events, and indexing.

This service is not the same thing as the ActivityPub bridge media resolvers used by `fedify-sidecar` for AP->AT projection. Those bridge endpoints fetch bytes synchronously for protocol projection, while `media-pipeline-sidecar` is the asynchronous derivative and analysis pipeline.

## S3 Provider Compatibility

The storage layer is S3 API-based and can target any provider that supports basic object operations (`PutObject`, `GetObject`, `DeleteObject`).

Environment controls:
- `S3_ENDPOINT`: provider API endpoint.
- `S3_REGION`: signing region used by the AWS SDK.
- `S3_BUCKET`: object bucket.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: API credentials.
- `S3_FORCE_PATH_STYLE`: defaults to `true` for broad S3-compatible support.
- `S3_PUBLIC_BASE_URL`: optional canonical URL base for public media links.
- `WORKER_SCRATCH_DIR`: local scratch directory used for streamed downloads and rendition staging.
- `WORKER_MAX_SCHEDULED_RETRIES`, `WORKER_RETRY_BASE_DELAY_MS`, `WORKER_RETRY_MAX_DELAY_MS`: bounded Redis-backed worker retry scheduling before DLQ.
- `WORKER_SCRATCH_MAX_AGE_MS`, `WORKER_SCRATCH_CLEANUP_INTERVAL_MS`: stale scratch directory self-healing.
- `FFMPEG_PATH` and `FFPROBE_PATH`: optional overrides for video tooling.
- `VIDEO_PLAYBACK_RENDITION_WIDTHS`, `VIDEO_PLAYBACK_CRF`, `VIDEO_PLAYBACK_AUDIO_BITRATE_KBPS`, `VIDEO_PLAYBACK_PRESET`: MP4 playback rendition ladder controls.
- `VIDEO_STREAM_SEGMENT_DURATION_SECONDS`: shared segment duration for HLS and DASH delivery manifests.
- `PDQ_HASH_SERVICE_BASE_URL`: optional PieFed-compatible PDQ hashing service base URL. When set, image jobs call `GET /pdq-hash?image_url=...` and emit raw PDQ hash signals for downstream MRF policy.
- `PDQ_HASH_SERVICE_BEARER_TOKEN`: optional bearer token sent to the PDQ hash service.

Container note:
- The provided Alpine Docker image installs native `ffmpeg`/`ffprobe` packages and exports `FFMPEG_PATH=/usr/bin/ffmpeg` plus `FFPROBE_PATH=/usr/bin/ffprobe`.
- Host-based development can still rely on the bundled static binaries when those env vars are not set.

If set, media URLs are built as `${S3_PUBLIC_BASE_URL}/{key}`.
If not set, fallback is `${S3_ENDPOINT}/{S3_BUCKET}/{key}`.

URL priority for externally served media:
1. `CLOUDFLARE_MEDIA_DOMAIN` if configured.
2. `S3_PUBLIC_BASE_URL` if configured.
3. Provider endpoint/bucket fallback.

## Filebase + IPFS Notes

Filebase is compatible because it exposes an S3 API for object writes and can additionally expose objects through an IPFS gateway model.

Operational impact versus plain S3:
- Object persistence still uses S3 semantics in this service.
- Optional gateway links are CID-based through `IPFS_GATEWAY_BASE` (with backward compatibility for `FILEBASE_GATEWAY_BASE`).
- Gateway-read latency and propagation can differ from direct S3 reads depending on gateway caching/availability.
- If strict low-latency media delivery is required, prefer CDN/object URL delivery and treat IPFS gateway URLs as secondary access paths.

## Production hardening defaults

- Stream payloads carry object references instead of inline media bytes.
- Fetch workers spool remote media to local scratch disk and upload transient objects by stream instead of buffering large payloads wholly in memory.
- Retryable worker failures are rescheduled through Redis with bounded exponential backoff before falling through to DLQ.
- Worker scratch directories are pruned opportunistically so stale crash leftovers do not accumulate forever on disk.
- Redis Streams are trimmed with bounded retention (`STREAM_MAX_LEN`, `DLQ_MAX_LEN`).
- Workers reclaim stale pending entries (`PENDING_MIN_IDLE_MS`, `PENDING_CLAIM_BATCH_SIZE`).
- Canonical assets persist to Redis by default (`ASSET_STORE_BACKEND=redis`) for multi-instance consistency.
- Legacy in-flight messages with `bytesBase64` are still accepted for safe migration.

## Supported media types

Implementation status:
- Images are normalized into canonical WebP plus preview and thumbnail derivatives.
- Videos now move through a dedicated rendition stage that can extract poster/thumbnail derivatives, metadata, bounded MP4 playback renditions, and HLS plus DASH delivery manifests using `ffmpeg`/`ffprobe`.
- The video stage preserves the uploaded canonical original and adds delivery-oriented playback and streaming variants rather than replacing the original asset.

### Images
- image/jpeg
- image/png
- image/webp
- image/gif
- image/avif

### Videos
- video/mp4
- video/webm
- video/quicktime

## Runtime note

The current cleaned branch runs with `tsx` for source execution. That is intentional.
The branch still uses extensionless ESM imports internally, so `node dist/...` would need a systematic `.js` import conversion or bundling pass before claiming emitted-JS runtime support.
Ingress runs on Node HTTP primitives with strict JSON body size limits and constant-time bearer token checks.

## Worker commands

- `npm run worker:ingest`
- `npm run worker:fetch`
- `npm run worker:process:image`
- `npm run worker:process:video`
- `npm run worker:rendition:video`
- `npm run worker:finalize`

## Smoke tests

Comprehensive smoke testing suite with multiple variants for different purposes:

### Local smoke (mocked fixture)
```bash
npm run smoke:runtime
```
- Uses in-memory fixture media server (no external dependencies)
- Best for: CI/CD, development, fast iteration
- Always available

### Public SSRF-validated smoke
```bash
SMOKE_PUBLIC_FIXTURE_URL='https://example.com/image.png' npm run smoke:runtime:public
```
- Validates media pipeline against real public URLs
- SSRF protection enabled and tested
- Best for: pre-deployment validation, security testing
- Requires internet connectivity

Environment variables:
- `SMOKE_PUBLIC_FIXTURE_URL` (required): public http(s) media URL
- `SMOKE_PUBLIC_EXPECT_KIND` (optional): `image` or `video`
- `SMOKE_REQUEST_TIMEOUT_MS` (optional, default 8000): request timeout in milliseconds
- `SMOKE_MAX_DOWNLOAD_BYTES` (optional, default 10MB): maximum payload size

### CI-friendly smoke (adaptive)
```bash
npm run smoke:runtime:ci
```
- Runs local smoke (always)
- Attempts public smoke if internet available
- Gracefully skips public tests if disconnected
- Best for: CI/CD pipelines, offline environments
- Exit code: 0 if local passes (public optional)

### Performance profiling smoke
```bash
npm run smoke:runtime:profile
```
- Runs the full local image smoke multiple times and reports total end-to-end latency
- Emits `min`, `avg`, `p50`, `p95`, and `max` timing summaries
- Supports `SMOKE_PROFILE_RUNS` and `SMOKE_PROFILE_FIXTURE_LATENCY_MS`
- Best for: regression detection and rough local baselines

### Chaos engineering smoke (resilience testing)
```bash
npm run smoke:runtime:chaos
```
- Runs real Redis-backed worker scenarios against `runSecureWorker`
- Validates scheduled retries, exponential backoff, recovery, and DLQ exhaustion paths
- Confirms non-retryable failures skip retry and land in DLQ directly
- Best for: validating error handling, resilience verification
- Exit code: 0 if recovery validated, 1 if resilience broken

### Video fixture smoke
```bash
npm run smoke:runtime:video
```
- Runs a deterministic local QuickTime fixture through the full video path
- Verifies fetch, MIME classification, storage, indexing, persistence, MP4 playback rendition generation, HLS plus DASH streaming manifests, and ActivityPub delivery projection preference
- Best for: end-to-end regression checks on the current video pipeline behavior
