# OS2 — Vector Architecture Decision

Status: **decision complete; exact-head CI required before merge**  
Base: OS1 merge `f57b1e08044119bd72109aca8b60abae7eae2b09`

## Decision

The current public-query runtime should use **OpenSearch for lexical/faceted public search without vector storage**.

Current master has no live semantic/vector query consumer. Therefore the current architecture should not pay the always-on CPU, memory, storage, indexing, and operational cost of either:

- an OpenSearch `knn_vector` on every public-content document; or
- a separate always-on Qdrant service storing the same public-content vector projection.

This is a current-runtime ownership decision, not a claim that vector search is permanently unnecessary. If a concrete future semantic-search, discovery, or recommendation feature requires ANN retrieval, OS2 preserves measured evidence for both modern OpenSearch and Qdrant so that feature can make an SLO-driven choice rather than inheriting historical Phase 5.5 assumptions.

## Live-call-site findings

Repository-wide inspection on the OS1 baseline found:

- `DefaultPublicSearchService` implements lexical, semantic, and hybrid OpenSearch queries, but has no live production construction site in `src/index.ts` or another runtime entry point.
- `EmbeddingIngestWorker` has no live construction site; its retry scan is explicitly unfinished and its mock model hard-codes 1024 dimensions.
- `PublicContentMapping` is the only OpenSearch mapping with a `knn_vector` field.
- the current V6 `SEARCH_BACKEND=dual` feed path chooses `QdrantFeedProvider` rather than `OpenSearchFeedProvider`;
- `QdrantFeedCandidateService` currently performs graph, trending, and tag-interest retrieval with Qdrant scroll/filter/order operations; it does **not** issue a vector/ANN query;
- `QdrantDocumentStore` explicitly reads with `with_vector: false` for normal hydration/candidate operations;
- the current Qdrant collection nevertheless stores 1024-dimensional vectors, while OpenSearch can also store the same vector.

The current repository is therefore maintaining two potential vector stores while no live query path requires ANN retrieval.

## Architectures measured

### A — `opensearch-lexical`

One OpenSearch service provides the current public-query requirements:

- public full-text search;
- filters/facets;
- public author/content lookup;
- graph/trending/tag candidate queries where retained;
- rebuildable public read projection.

No `knn_vector`, embedding ingest worker, or Qdrant service is required.

### B — `opensearch-vector-32x`

OpenSearch 3.8 provides lexical search and 1024-dimensional vectors in the same service using:

- `mode: on_disk`;
- `compression_level: 32x`;
- one shard / zero replicas for the isolated OS2 comparison;
- bulk ingestion with refresh disabled during load;
- force-merge and flush before steady-state disk measurement.

32x was selected as a low-memory modern OpenSearch characterization point, not as a final vector-quality configuration.

### C — `opensearch-plus-qdrant`

OpenSearch provides lexical/faceted search while Qdrant 1.19 provides future ANN retrieval. Qdrant was configured with:

- original vectors on disk;
- HNSW on disk;
- int8 scalar quantization;
- payload indexes only for the current filter/candidate shape.

CPU, memory, disk, and service count are measured for **both services together**. This prevents a misleading comparison of Qdrant alone against an OpenSearch deployment that the architecture would still need for lexical search.

## Current versions used for evidence

- OpenSearch: `opensearchproject/opensearch:3.8.0`
- Qdrant: `qdrant/qdrant:v1.19.0`
- Node benchmark runtime: 22.23.x

The production compose remains unchanged in OS2. OS3 is responsible for upgrading the surviving OpenSearch runtime.

## Hardened benchmark methodology

Workflow: `.github/workflows/opensearch-os2-vector-architecture.yml`  
Harness: `fedify-sidecar/scripts/benchmark-search-vector-architecture.mjs`

The final benchmark uses:

- 6,000 deterministic public-social documents;
- 1024-dimensional normalized vectors;
- 3 fresh repeats per architecture arm;
- 9 fresh service deployments total;
- identical short-post, reply/interaction, media-metadata, and article-like payload classes;
- repeated actors, protocols, languages, tags, and engagement fields;
- OpenSearch force-merge to one segment plus flush before disk measurement;
- Qdrant wait for green collection state, optimizer `ok`, and bounded segment count before measurement;
- cgroup service CPU, current memory, peak memory, and service data-disk accounting;
- lexical, filtered-candidate, and vector p50/p95/p99 latency;
- exact-self top-1 correctness;
- ANN top-10 overlap against brute-force cosine ground truth.

The first single-run harness was explicitly superseded because it measured Qdrant disk before optimizer convergence and only checked self-retrieval. Final OS2 evidence comes from the repeated steady-state harness.

## Final repeated evidence

Median of three fresh runs:

| Metric | OpenSearch lexical | OpenSearch + 32x vector | OpenSearch + Qdrant |
|---|---:|---:|---:|
| Ingest CPU | 3,426.8 ms | 7,563.2 ms | 4,590.7 ms |
| Ingest throughput | 4,968.9 docs/s | 1,402.5 docs/s | 2,128.3 docs/s |
| Settled memory | 996,884,480 B | 1,083,756,544 B | 1,275,613,184 B |
| Peak memory | 1,000,906,752 B | 1,228,873,728 B | 1,322,594,304 B |
| Measured service-data disk | 1,785,322 B | 70,991,129 B | 482,628,988 B |
| Lexical p95 | 10.304 ms | 12.121 ms | 9.283 ms |
| Filter/candidate p95 | 5.838 ms | 6.536 ms | 2.155 ms |
| Vector p95 | n/a | 11.458 ms | 2.751 ms |
| Exact-self top-1 | n/a | 1.000 | 1.000 |
| Brute-force ANN recall@10 | n/a | **0.4625** | **0.9625** |

Relative to lexical-only OpenSearch:

### OpenSearch 32x vectors

- ingest CPU: **2.21x**;
- ingest throughput: **0.28x**;
- settled memory: **1.087x** (~8.7% higher);
- peak memory: **1.228x**;
- lexical p95: **1.176x**;
- filter p95: **1.120x**.

The tested 32x low-memory configuration did **not** satisfy the frozen ANN-quality guard on this deliberately difficult deterministic corpus. Recall@10 was 0.4625 in all three repeats.

This does not mean OpenSearch 3.8 vector search is categorically unsuitable. OpenSearch exposes search-time `ef_search` and rescoring/oversampling controls that can trade latency/CPU for recall, and lower vector compression levels are also available. OS2 deliberately does not spend further resources optimizing a dormant capability that current runtime code does not use.

### Split OpenSearch + Qdrant

- ingest CPU: **1.34x**;
- ingest throughput: **0.43x**;
- settled memory: **1.280x** (~28% higher);
- peak memory: **1.321x**;
- Qdrant filter/candidate p95 was materially faster than the equivalent OpenSearch filter path in this small isolated benchmark;
- vector p95 was ~2.75 ms;
- brute-force ANN recall@10 was **0.9625** median and remained >=0.95 in every repeat.

Qdrant therefore demonstrated a viable future ANN path under the tested settings, but that does not justify running it today when no live consumer requests vector retrieval.

## Disk-number interpretation

The 6,000-document disk ratios are **not scale projections**.

The lexical-only index is tiny, while both vector architectures carry substantial fixed index/vector/WAL/segment metadata. The resulting ~40x and ~270x ratios are useful only as proof that vectors add real storage and fixed operational overhead at small scale. They must not be extrapolated linearly to millions of documents.

OS5/OS7 are responsible for scale curves and storage optimization if a vector architecture is ever activated.

## Current-runtime decision

**Selected: `opensearch-lexical`.**

Reasons:

1. there is no live semantic/vector query consumer;
2. it is the only one-service architecture that satisfies current public-query requirements without dormant vector structures;
3. the tested OpenSearch vector configuration adds ~8.7% settled memory and more than doubles indexing CPU;
4. the split Qdrant architecture adds ~28% settled memory and a second always-on database;
5. Redpanda remains the replayable durable source for rebuilding the public-query projection, so vector infrastructure can be introduced later without making today’s projection authoritative.

## Future-vector decision

OS2 **does not select a production future-vector backend**.

The tested Qdrant configuration passed the frozen recall guard. The tested OpenSearch 32x low-memory configuration did not. That is useful characterization evidence, but the current product has no live ANN requirement and therefore supplies no valid latency/recall/cost SLO with which to choose or tune a future vector system.

If a future semantic feature arrives:

- Qdrant 1.19 is a proven viable candidate from this evidence;
- OpenSearch 3.8 remains a candidate after an explicit recall-tuning sweep using compression level, `ef_search`, and rescoring/oversampling;
- the future feature must compare **whole deployment cost**, not isolated vector-engine cost;
- no arbitrary weighted score should choose the backend.

## Consequences for OS3

OS3 should upgrade the **surviving lexical/faceted OpenSearch path** to 3.8.

For the current canonical public-content mapping/startup path, OS3 should not preserve historical vector assumptions merely because they exist today:

- remove/omit `knn_vector` from the active public-content index generation;
- do not create the historical OpenSearch hybrid pipeline for the current runtime;
- do not require embedding-status fields solely for the dormant Phase 5.5 worker;
- configure the default current search backend as OpenSearch rather than `dual`;
- make Qdrant non-required/disabled in the current runtime topology while preserving its code until OS10 or a concrete future-vector feature decides otherwise;
- keep `public-author` as lexical OpenSearch;
- leave stored-field codec, Zstd level, source optimization, shard sizing, replica sizing, and final refresh/bulk tuning to their dedicated later phases.

OS3 should not delete every Qdrant or historical hybrid-search source file. Cleanup remains OS10 after reference/CI verification. The goal is to stop paying the runtime cost now without destroying evidence or optional future code prematurely.

## What OS2 intentionally does not decide

OS2 does not decide:

- final OpenSearch stored-field codec;
- final Zstd level;
- final OpenSearch vector compression/quantization setting;
- derived-source policy;
- production shard/replica counts;
- production cluster size;
- refresh interval/bulk sizing;
- hybrid ranking weights;
- embedding model or embedding-generation architecture.

## Exit criteria

OS2 is complete when the exact final PR head proves:

1. Fast Checks pass;
2. AP interop passes;
3. all 9 repeated benchmark deployments complete and produce evidence;
4. OpenSearch 3.8 lexical-only successfully indexes and answers current query workloads;
5. vector characterization records both exact-self correctness and brute-force ANN recall;
6. at least one tested future-vector architecture passes the frozen 0.90 recall@10 quality guard (Qdrant does in the current evidence);
7. the current-runtime decision is `opensearch-lexical`;
8. no production runtime configuration changes are mixed into OS2.

The next phase after merge is **OS3 — upgrade the surviving OpenSearch runtime to 3.8 and narrow the active mapping/startup topology to the OS2 decision**.
