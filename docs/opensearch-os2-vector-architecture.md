# OS2 — Vector Architecture Evidence

Status: **measurement phase**  
Base: OS1 merge `f57b1e08044119bd72109aca8b60abae7eae2b09`

## Purpose

OS2 decides whether the public-query tier should pay for vector storage/search at all, and if a future semantic-search feature needs vectors, whether those vectors belong in OpenSearch 3.8 or a separate Qdrant service.

This phase deliberately precedes the general OpenSearch 3.8 migration. We should not migrate or optimize vector code that current runtime requirements do not use.

## Live-call-site findings

Repository-wide inspection on the OS1 baseline found:

- `DefaultPublicSearchService` implements lexical, semantic and hybrid OpenSearch queries, but has no live construction site in `src/index.ts` or another production runtime entry point.
- `EmbeddingIngestWorker` has no live construction site; its retry scan is explicitly unfinished and its mock model hard-codes 1024 dimensions.
- `PublicContentMapping` is the only OpenSearch mapping with a `knn_vector` field.
- the default V6 `SEARCH_BACKEND=dual` feed path chooses `QdrantFeedProvider` rather than `OpenSearchFeedProvider`;
- `QdrantFeedCandidateService` currently performs graph, trending and tag-interest retrieval with Qdrant scroll/filter/order operations; it does **not** issue a vector/ANN query;
- `QdrantDocumentStore` explicitly reads with `with_vector: false` for normal hydration/candidate operations;
- the current Qdrant collection nevertheless stores 1024-dimensional vectors and the OpenSearch mapping can also store a 1024-dimensional vector.

Therefore there is no demonstrated live semantic/vector query requirement on current master. Maintaining vector structures must be justified by a concrete future feature rather than by historical Phase 5.5 code.

## Current-runtime architecture candidates

### A — OpenSearch lexical/faceted only

One OpenSearch service provides the actual live requirements:

- public full-text search;
- filters/facets;
- public author/content lookup;
- graph/trending/tag candidate queries where retained;
- rebuildable public read projection.

No `knn_vector`, embedding ingest worker or Qdrant service is required for the current runtime.

### B — OpenSearch 3.8 lexical + vectors

OpenSearch remains the only search service and additionally owns future vector retrieval.

The benchmark uses the current 1024-dimensional shape but modernizes the vector storage to the low-memory OpenSearch 3.8 form:

- `mode: on_disk`;
- `compression_level: 32x`;
- one shard / zero replicas for the OS2 single-node comparison;
- bulk ingestion with refresh disabled during load and one explicit refresh after ingestion.

OS2 uses 32x because it is a modern low-memory architecture characterization, not because OS2 is selecting final vector compression. If OpenSearch vectors survive OS2, their final precision/compression belongs to a later measured storage/search phase.

### C — OpenSearch lexical + Qdrant vector companion

OpenSearch retains lexical/faceted public search and Qdrant owns future vector retrieval.

The Qdrant 1.19 benchmark uses stable low-memory settings:

- original vectors on disk;
- HNSW on disk;
- int8 scalar quantization;
- payload indexes only for fields needed by the current candidate/filter shape.

The benchmark counts **both** OpenSearch and Qdrant resources. Comparing Qdrant vector RAM alone against OpenSearch would hide the cost of keeping a second always-on database and a duplicated document projection.

## Why Qdrant 1.19 is evaluated rather than the repository pin

The repository currently pins Qdrant 1.13.4, but Qdrant 1.19 materially changes memory/storage controls and is the appropriate current comparison against OpenSearch 3.8. OS2 does not upgrade the production compose yet; it uses current images only inside the isolated evidence workflow.

## Benchmark

Workflow: `.github/workflows/opensearch-os2-vector-architecture.yml`  
Harness: `fedify-sidecar/scripts/benchmark-search-vector-architecture.mjs`

Images:

- `opensearchproject/opensearch:3.8.0`
- `qdrant/qdrant:v1.19.0`

The benchmark creates fresh containers for each architecture arm and indexes an identical deterministic public-social corpus with:

- short public posts;
- replies/interactions;
- media-heavy metadata;
- long-form/article-like text;
- repeated actors, protocols, languages, tags and engagement fields;
- deterministic normalized 1024-dimensional vectors.

The first full CI evidence population uses 6,000 documents. This is intended to expose relative service/index overhead on a hosted CI runner; OS5 later establishes production topology and scale curves.

## Measurements

For each whole-deployment arm the harness records:

- service CPU consumed during ingestion;
- ingestion wall time and documents/second;
- idle cgroup memory;
- settled post-ingest cgroup memory;
- cgroup peak memory;
- on-disk service data bytes;
- lexical query p50/p95/p99;
- filtered candidate query p50/p95/p99;
- vector query p50/p95/p99 for vector-capable arms;
- exact-vector recall@1 and recall@10;
- number of always-on services.

For the split OpenSearch+Qdrant architecture, CPU, memory and disk are summed across both containers.

## Decision policy

### Current runtime

The current-runtime decision is requirements-first rather than benchmark-score-first.

If lexical/faceted OpenSearch produces valid indexing/query evidence, **A — OpenSearch lexical/faceted only** is selected because current master has no live vector consumer. A dormant future capability does not justify an always-on resource cost or duplicated vector storage.

This decision can be revisited when an actual semantic-search/recommendation feature reaches a design boundary that needs vectors.

### Future vector capability

OS2 still characterizes B and C so a future vector feature has current evidence.

Both vector candidates must first pass correctness:

- recall@10 >= 0.95 for exact stored-vector queries;
- nonzero latency/resource evidence.

After correctness, the benchmark reports a Pareto frontier across:

- settled memory;
- disk;
- ingestion CPU;
- vector p99 latency;
- service count.

No arbitrary weighted “cost score” is used. A future-vector winner is named only if one candidate actually dominates the other across those measured objectives. Otherwise both remain on the frontier until a concrete future feature supplies real SLOs/cost weights.

## What OS2 does not decide

OS2 does **not** decide:

- final OpenSearch stored-field codec;
- final Zstd level;
- final OpenSearch vector compression/quantization level;
- derived-source policy;
- production shard/replica counts;
- production cluster size;
- refresh interval/bulk sizing;
- hybrid ranking weights;
- embedding model or embedding-generation architecture.

Those belong to later phases after vector ownership is settled.

## Exit criteria

OS2 can close when:

1. exact live call sites remain documented and no live semantic consumer has been missed;
2. OpenSearch 3.8 lexical-only successfully indexes and answers current-query workloads;
3. OpenSearch 3.8 on-disk vector search passes the correctness probe;
4. Qdrant 1.19 on-disk/quantized vector search passes the correctness probe;
5. whole-deployment CPU/memory/disk/query evidence is captured for A/B/C;
6. the current-runtime vector ownership decision is recorded without vendor-benchmark assumptions;
7. any future-vector recommendation is Pareto-based rather than an arbitrary weighted score;
8. no production runtime configuration is changed before the OS2 decision is accepted.
