# Media Pipeline Sidecar

Focused media infrastructure service for the Mastopod federation architecture.

## Responsibilities

- secure remote media ingress
- MIME and file validation
- media transformation and derivative generation
- S3-compatible canonical storage (Filebase, AWS S3, MinIO, R2, B2 S3 API)
- Cloudflare delivery URL generation
- raw safety signal collection adapters
- protocol-specific media projection helpers
- media lifecycle events and indexing payloads

## Non-responsibilities

- final moderation decisions
- feed filtering or ranking policy
- user safety preferences
- human moderation workflow

## Runtime shape

```text
queue ingress -> ingest worker -> fetch worker -> process:image|video -> finalize worker
```

The finalize stage persists the canonical asset, emits a media lifecycle event, and writes a media indexing payload. Any safety signals are emitted as raw signals only for downstream MRF evaluation.

## S3 Provider Compatibility

The storage layer is S3 API-based and can target any provider that supports basic object operations (`PutObject`, `GetObject`, `DeleteObject`).

Environment controls:
- `S3_ENDPOINT`: provider API endpoint.
- `S3_REGION`: signing region used by the AWS SDK.
- `S3_BUCKET`: object bucket.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: API credentials.
- `S3_FORCE_PATH_STYLE`: defaults to `true` for broad S3-compatible support.
- `S3_PUBLIC_BASE_URL`: optional canonical URL base for public media links.

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
- Redis Streams are trimmed with bounded retention (`STREAM_MAX_LEN`, `DLQ_MAX_LEN`).
- Workers reclaim stale pending entries (`PENDING_MIN_IDLE_MS`, `PENDING_CLAIM_BATCH_SIZE`).
- Canonical assets persist to Redis by default (`ASSET_STORE_BACKEND=redis`) for multi-instance consistency.
- Legacy in-flight messages with `bytesBase64` are still accepted for safe migration.

## Supported media types

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
- Measures end-to-end latency through pipeline
- Captures component timing breakdowns
- Identifies bottlenecks in fetch/process/finalize
- Best for: performance regression detection, baseline establishment
- Output: formatted timing metrics

### Chaos engineering smoke (resilience testing)
```bash
npm run smoke:runtime:chaos
```
- Injects transient failures: 500 errors, 429 rate limits, timeouts
- Validates retry logic and exponential backoff
- Tests dead-letter queue (DLQ) handling
- Best for: validating error handling, resilience verification
- Exit code: 0 if recovery validated, 1 if resilience broken

### Video fixture smoke
```bash
npm run smoke:runtime:video
```
- Validates video processing pipeline
- Tests with local MP4/WebM fixtures and public video URLs
- Checks MIME detection, upload, metadata
- Best for: video codec coverage, end-to-end video validation
- Exit code: 0 if video processing works, 1 if failed
