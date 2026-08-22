# OS3 — OpenSearch 3.8 lexical runtime

Status: implementation / validation  
Base: OS2 merge `1b95d68159eb1cfa1f3cb0ab08b342bdd6ab30d2`

## Decision carried forward from OS2

The current Tier-3 public-query workload does not have a live semantic/ANN consumer. The active runtime therefore uses one OpenSearch lexical/faceted projection and does not require a second vector database or an OpenSearch `knn_vector` field.

Qdrant and vector-capable source code remain available for a future feature with a concrete semantic-search SLO. They are not deleted in OS3.

## Runtime changes

OS3 makes the following production-bound changes:

- V6 OpenSearch image: `opensearchproject/opensearch:3.8.0`.
- Default compose backend: `SEARCH_BACKEND=opensearch`.
- Production container default: `SEARCH_BACKEND=opensearch`.
- Qdrant compose service: explicit `vector-experimental` profile; it is not part of default `docker compose up`.
- Qdrant image for the optional profile: `qdrant/qdrant:v1.19.0`, matching the OS2 comparison target.
- `public-content-v1` fresh-cluster mapping: lexical/faceted only; no `knn_vector`, `embeddingStatus`, `embeddingUpdatedAt`, `index.knn`, or `default_pipeline`.
- OpenSearch bootstrap: cluster health + public-content/public-author indices only. Historical embedding-ingest and hybrid-search pipelines are no longer prerequisites for the current runtime.
- Existing `public-content-v1` indices have any historical `index.default_pipeline` explicitly changed to `_none` during bootstrap before additive mapping reconciliation.
- Content and author mutation clients no longer use `refresh: true` for every write/delete.
- Both typed configuration modules now default/validate the OpenSearch-first search policy instead of silently treating dual/Qdrant as the fallback.

## Existing-index behavior

OpenSearch mappings are additive. An existing `public-content-v1` index created by an older release can retain historical vector fields after an in-place upgrade because field removal is not a valid mapping update. The historical `index.knn` setting can likewise remain on such a physical index until it is rebuilt; it is not treated as an active OS3 capability.

The old default ingest pipeline is different because leaving it attached would affect every new write. OS3 therefore sets `index.default_pipeline` to OpenSearch's explicit `_none` value on an existing `public-content-v1` before accepting the index. Bootstrap fails closed if that setting cannot be changed. This lets operators remove the obsolete embedding pipeline without breaking indexing and prevents it from adding legacy embedding-status state to new lexical-only documents.

Historical vector fields/settings do **not** make vectors an active OS3 requirement:

- OS3 does not create or attach the embedding ingest pipeline;
- OS3 does not generate vectors in the active projection path;
- OS3 does not perform ANN queries;
- new fresh installations receive the lexical-only mapping;
- existing physical vector segments are treated as reclaimable Tier-3 residue rather than authority.

A later storage/index migration phase may rebuild the Tier-3 projection into a new physical index/alias if measurements show that reclaiming historical vector segments materially improves production cost. Tier-3 remains rebuildable, so this does not require changing protocol or durable-log authority.

## OpenSearch JavaScript client compatibility

The repository currently uses `@opensearch-project/opensearch` 2.x. OS3 does not blindly change the dependency and lockfile solely because the server major version changed. Instead, the OS3 live gate starts OpenSearch 3.8.0 and exercises the exact client operations this runtime uses:

- cluster health;
- index creation and mapping inspection;
- existing-index settings migration via `indices.putSettings`;
- content update/upsert;
- author update/upsert;
- GET;
- lexical search;
- scripted update;
- delete;
- explicit index refresh used only by the test to establish deterministic visibility.

The live smoke tests both a fresh lexical-only index and a synthetic legacy index carrying a default embedding pipeline. It requires bootstrap to change that legacy pipeline to `_none`, then verifies a subsequent content write is not mutated by the legacy pipeline.

If this client contract fails against 3.8, the client upgrade becomes part of OS3 and must be validated before merge. If it passes, a client-major upgrade can be handled separately from the server migration rather than combining two breaking-change surfaces without evidence.

## Validation

Workflow: `.github/workflows/opensearch-os3-compatibility.yml`  
Smoke: `fedify-sidecar/scripts/smoke-opensearch-3-8.ts`

The gate also checks that Qdrant is absent from the default compose service set and appears only when `--profile vector-experimental` is requested.

Normal repository Fast Checks and ActivityPub interop remain regression gates on the PR head.

## Not part of OS3

OS3 intentionally does not select:

- final shard/replica topology;
- stored-field compression codec;
- Zstd level for OpenSearch stored fields;
- source-mode/derived-source policy;
- refresh interval and bulk-size production tuning;
- a future vector engine;
- embedding model or semantic-ranking policy.

Those are measured in subsequent OpenSearch phases after the 3.8 lexical runtime is proven stable.
