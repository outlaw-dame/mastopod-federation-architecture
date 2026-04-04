# Media Pipeline Sidecar — Canonical Architecture

This document resets the media service in the correct direction for the federation architecture.

## Target topology

```text
Fedify Sidecar -> Media Pipeline   (direct fetch / resolve / projection)
ActivityPods   -> Media Pipeline   (ingest / delete / reference lifecycle)
AT Adapter     -> Media Pipeline   (blob binding / projection)
```

## Design goal

The media pipeline is **not** a generic file server.
It is a **protocol-aware canonical media boundary** that:

1. normalises raw media into canonical assets
2. stores canonical bytes and variants in Filebase/IPFS-backed storage
3. exposes ActivityPub-safe URL projections
4. exposes ATProto-safe blob bindings and embed projections
5. emits durable media domain events for OpenSearch and downstream systems

## Core separation of concerns

### A. Operational pipeline
Use **Redis Streams** for queue/workflow semantics:

- `media:fetch:remote`
- `media:inspect`
- `media:process:image`
- `media:process:video`
- `media:store:filebase`
- `media:bind:activitypub`
- `media:bind:atproto`
- `media:finalize`
- `media:delete`
- `media:gc`
- `media:dlq`

These streams are for retries, backoff, ownership, and worker orchestration.

### B. Durable domain events
Use **RedPanda** for domain facts, not worker mechanics:

- `media.asset.created.v1`
- `media.asset.updated.v1`
- `media.asset.deleted.v1`
- `media.asset.variant.created.v1`
- `media.asset.bound.activitypub.v1`
- `media.asset.bound.atproto.v1`
- `media.asset.unreferenced.v1`
- `media.asset.moderation_changed.v1`

These events are consumed by OpenSearch indexers, hydration systems, moderation systems, analytics, and cleanup tooling.

### C. Search/index layer
Use **OpenSearch** only for read/search documents derived from durable media domain events.
Do not index directly from worker queues.

## Canonical asset model

The system must maintain a canonical internal asset record independent of protocol shape.

Canonical fields:

- `assetId`
- `ownerId` (`actorUri` and/or `did`)
- `sha256`
- `cid`
- `filebaseObjectKey`
- `canonicalUrl`
- `gatewayUrl`
- `mimeType`
- `kind`
- `width`
- `height`
- `size`
- `variants`
- `blurhash`
- `alt`
- `moderation`
- `createdAt`
- `updatedAt`

## Protocol bindings

### ActivityPub binding
ActivityPub remains URL-oriented.
The binding should project canonical assets to HTTP(S) URLs and ActivityStreams-compatible metadata:

- canonical media URL
- preview/thumbnail URLs
- `mediaType`
- `width`
- `height`
- `Link` / `Image` / `attachment`-safe representation

### ATProto binding
ATProto remains blob-oriented.
The binding should project canonical assets to account-scoped blob references and embed-safe metadata:

- blob ref metadata
- mime type
- size
- alt text
- image embed projection
- video embed projection
- DID/repo/PDS binding metadata

## Filebase/IPFS stance

Filebase/IPFS is the storage substrate, not the primary protocol contract.

Rules:

1. AP-facing media should prefer canonical HTTPS media URLs under your domain.
2. Internal metadata must still retain CID and gateway references.
3. ATProto bindings must preserve blob semantics even when canonical bytes are stored in Filebase.
4. The media pipeline should support future dedicated gateways or CDN replacement without changing protocol records.

## Required internal endpoints

### Fedify-facing
- `POST /internal/media/resolve-remote`
- `POST /internal/media/project/activitypub`

### ActivityPods-facing
- `POST /internal/media/ingest`
- `POST /internal/media/delete`
- `POST /internal/media/reference`
- `POST /internal/media/unreference`

### AT-facing
- `POST /internal/media/project/atproto`
- `POST /internal/media/bind-blob`

## Implementation priorities

1. establish canonical asset + binding contracts
2. establish Redis Streams and RedPanda topic contracts
3. establish OpenSearch document contract
4. move HTTP surface toward projection-oriented endpoints
5. add image and video workers behind Redis Streams

## Non-goals for the first slice

- public upload surface
- direct client-facing blob service
- forcing AP and ATProto into one shared protocol representation

The first slice should move the repository toward the correct contracts and service boundaries.
