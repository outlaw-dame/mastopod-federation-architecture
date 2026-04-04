# Media Pipeline Sidecar (Tier 3)

High-performance media processing service for the Mastopod + ActivityPods architecture.

## Purpose

This service implements the **Tier 3 media pipeline** described in the architecture:

- Image processing (libvips via sharp)
- Video processing (FFmpeg)
- Content-addressed storage (S3/Filebase)
- Deterministic transformations (WebP, thumbnails, variants)
- Secure media fetching + sanitisation

It is **decoupled from ActivityPods** and integrates via internal APIs and event streams.

## Key Endpoints

### POST /internal/media/resolve
Fetch and return remote media (used by bridge resolvers)

### POST /internal/media/ingest
Process + store uploaded or fetched media

## Integration Points

- ActivityPods can proxy:
  - /api/internal/activitypub-bridge/resolve-media
  - /api/internal/activitypub-bridge/resolve-profile-media
- Fedify sidecar uses resolved media for projection
- RedPanda events (optional):
  - media.ingest.requested.v1
  - media.ingest.completed.v1
  - media.ingest.failed.v1

## Security

- Blocks private network SSRF by default
- Enforces max payload sizes
- Requires internal bearer token
- Validates MIME type + magic bytes

## Architecture Alignment

Matches Tier 3 definition:

- Processing BEFORE hashing
- Content-addressed storage
- Async event-driven workflow

## Run

```bash
npm install
npm run dev
```
