# OS1 — OpenSearch Responsibility and Legacy-Path Audit

Status: **OS1 baseline / decision record**  
Repository baseline: `db3ceb63562bb1408290ddd83c146f7c880279b2`  
Scope: inventory and classify current OpenSearch, Qdrant, vector, indexing, and public-query code before the OpenSearch 3.8 upgrade.

## 1. Decision summary

OpenSearch remains a valid Tier-3 component, but its responsibility must be narrower than parts of the current code imply.

The authoritative architecture boundary is:

> **OpenSearch is a rebuildable public-query projection downstream of Redpanda. It is not protocol authority, identity authority, inbox authority, durable event-log authority, private-data authority, or general-purpose primary storage.**

OS1 found substantial historical overlap in the repository:

1. the current `public-content-v1` OpenSearch mapping still embeds a 1024-dimensional `knn_vector` and the bootstrap creates a hybrid lexical/vector search pipeline;
2. the current V6 compose file explicitly describes OpenSearch as a **legacy read-side dependency during feed migration** and Qdrant as the **primary vector search backend**;
3. `SearchIndexerService` still supports `SEARCH_BACKEND=opensearch|qdrant|dual`, so the migration/comparison seam is active in code;
4. at least three OpenSearch ingestion generations coexist:
   - `src/services/opensearch.ts` + `StreamsService`;
   - `src/streams/opensearch-indexer.ts`;
   - the newer `src/search/service/SearchIndexerService.ts` stack;
5. Redpanda Connect also contains separate OpenSearch sink pipelines, including a direct `ap.firehose.v1 -> ap-activities` path;
6. Qdrant has its own bootstrap, vector collection, feed/document-store, hydrator, and candidate-query paths rather than being a stub;
7. some Phase 5.5 search/vector code is visibly incomplete or prototype-oriented (`scanAndRetry` is not implemented, comments still say “in a real implementation”, and feed candidate generation documents semantic expansion as future work).

Therefore OS1 **does not preserve the current OpenSearch vector mapping by default**. Vector ownership is explicitly deferred to OS2, where OpenSearch 3.8 versus Qdrant will be evaluated from current requirements and measured resource cost.

No runtime path is deleted in OS1. Deletion before OS2 would risk removing a migration seam or test fixture that still carries useful behavior.

---

## 2. Authoritative architecture boundary

`ARCHITECTURE-BASELINE.md` is authoritative over older architecture documents. Its relevant invariant is that OpenSearch belongs to Tier 3 as a public-query/application service and is never a source of truth for federation, signing, inbox state, repository state, or canonical identity.

The intended data/control plane for public search is therefore:

```text
ActivityPods / Fedify / native AT runtime
                |
                | public events only after Tier-2 policy/trust boundary
                v
             Redpanda
                |
                | replayable durable event log
                v
          Search projection
                |
                v
            OpenSearch
                |
                +-- public full-text search
                +-- public facets/filters
                +-- public author lookup
                +-- public activity hydration/read projection
                `-- vector/hybrid search only if OS2 proves it belongs here
```

The key recovery property is important for every later phase: **OpenSearch must be rebuildable from authoritative/replayable upstream state.** A codec, shard, mapping, or index-generation migration must not require treating OpenSearch segments as irreplaceable data.

---

## 3. Current runtime/version baseline

The current V6 compose file pins:

- OpenSearch `2.17.1`;
- Qdrant `1.13.4`;
- `SEARCH_BACKEND=dual`;
- `ENABLE_OPENSEARCH_INDEXER=true`;
- Qdrant collection `public-content-v1` with vector size `1024`.

The compose comments are themselves architectural evidence:

- OpenSearch: **“legacy read-side dependency during feed migration”**;
- Qdrant: **“primary vector search backend”**.

That is inconsistent with treating the OpenSearch `knn_vector` field as unquestionably current architecture. OS2 must reconcile this seam.

The OpenSearch 3.8 upgrade belongs in OS3, after OS2 decides which vector responsibilities are worth migrating.

---

## 4. Inventory and classification

Classification labels:

- **RETAIN** — clearly aligned with the current Tier-3 public-query responsibility.
- **RETAIN / HARDEN** — aligned responsibility, but implementation needs performance/correctness work before production.
- **OS2 DECISION** — vector/search ownership is unresolved; keep until the vector architecture decision.
- **LEGACY CANDIDATE** — superseded/duplicated path with no evidence it should remain long term; remove only after reference/CI validation.
- **ALTERNATE PIPELINE** — operational alternative that overlaps the primary path and needs an explicit ownership decision.

### 4.1 `src/search/service/SearchIndexerService.ts`

**Classification: RETAIN / HARDEN (primary candidate)**

Why it aligns:

- consumes the canonical V6 `ap.firehose.v1` and tombstone topics;
- owns an independent Kafka consumer group;
- applies the public-search consent gate before indexing;
- projects AP events into the newer public content/author models;
- includes explicit backpressure behavior;
- uses the current Redpanda compression registration invariant.

Why it still needs architectural cleanup:

- has `searchBackend: 'opensearch' | 'qdrant' | 'dual'`;
- constructs both OpenSearch and Qdrant stores;
- in dual mode its current store-selection semantics must be reviewed carefully; “dual” must mean intentional mirrored behavior rather than implicit preference;
- it is still entangled with the unresolved vector-backend migration.

OS1 position: this is the strongest candidate for the **single canonical Redpanda -> search projection service** after OS2/OS4 cleanup.

### 4.2 `src/search/mappings/PublicContentMapping.ts`

**Classification: mixed — RETAIN core schema; OS2 DECISION for vectors**

Clearly aligned fields include:

- stable/canonical document identifiers;
- AP/AT protocol projections;
- public author projection;
- text and non-indexed raw text;
- timestamps/languages/tags;
- reply/quote relations;
- public media metadata;
- engagement/ranking projection fields;
- deletion state.

Unresolved legacy/vector fields:

```text
embedding: knn_vector
  dimension: 1024
  mode: on_disk
  compression_level: 16x
embeddingStatus
embeddingUpdatedAt
```

These are not automatically part of the final OpenSearch 3.8 mapping. OS2 must prove that keeping embeddings in OpenSearch is cheaper/simpler/better than Qdrant or a separate vector layer.

The current `number_of_shards: 3` and `number_of_replicas: 1` are also **not accepted as production sizing decisions**. They become OS5/OS8 evidence questions.

### 4.3 `src/search/mappings/PublicAuthorMapping.ts`

**Classification: RETAIN / HARDEN**

This mapping is well aligned with OpenSearch’s public-query role:

- public identity projections;
- display-name/summary text search;
- labels/languages;
- explicit public search-consent fields;
- protocol/source projection;
- update timestamp.

It contains no k-NN vector. It is therefore a clean early target for the OpenSearch 3.8 upgrade and later stored-field compression tests.

Its `1 shard / 1 replica` settings remain a sizing hypothesis, not a frozen production value.

### 4.4 `src/search/writer/OpenSearchClient.ts`

**Classification: RETAIN / HARDEN**

The abstraction is useful, but the implementation currently forces `refresh: true` for normal upserts, scripted updates, deletes, and author writes.

That is inappropriate as a production default for an asynchronous Redpanda projection and is explicitly acknowledged by the source comment as testing/immediate-visibility behavior.

OS4 must replace per-write forced refresh with a bounded batching/refresh strategy before any codec benchmark is considered production-representative.

### 4.5 `src/search/service/OpenSearchBootstrapService.ts`

**Classification: mixed — RETAIN bootstrap mechanics; OS2 DECISION for hybrid/vector pieces**

Good reusable behavior:

- bounded cluster-health retries;
- exponential backoff + deadline;
- idempotent index creation;
- safe additive mapping updates;
- credential/TLS handling.

Provisional behavior:

- always creates `public-hybrid-pipeline-v1`;
- always installs a default ingest pipeline that sets `embeddingStatus=pending`;
- assumes the OpenSearch hybrid/vector search design is still canonical.

OS3 should retain the robust bootstrap mechanics while rebuilding index templates/pipelines around the OS2 decision and OpenSearch 3.8 capabilities.

### 4.6 `src/search/queries/HybridQueryBuilder.ts`

**Classification: OS2 DECISION**

This is explicitly a Phase 5.5 OpenSearch lexical + semantic + hybrid implementation. It constructs:

- BM25 lexical queries;
- OpenSearch k-NN queries against `embedding`;
- OpenSearch hybrid queries;
- a normalization/combination pipeline with fixed 65% lexical / 35% semantic weighting.

Those weights and OpenSearch ownership are historical design choices, not current architecture invariants.

Do not migrate this automatically to OpenSearch 3.8. OS2 must decide whether hybrid search should be:

1. all in OpenSearch 3.8;
2. lexical/facets in OpenSearch + vectors in Qdrant;
3. performed by a separate recommendation/search layer;
4. removed from this repo’s public-query responsibility if another canonical subsystem now owns it.

### 4.7 `src/search/queries/PublicSearchService.ts`

**Classification: mixed — RETAIN lexical public search concept; OS2 DECISION semantic/hybrid modes**

The public API currently defaults to `mode='hybrid'`, creates query embeddings synchronously, and routes through OpenSearch hybrid search.

That default should not survive OS2 merely because it exists today.

Additional implementation debt found during OS1:

- pagination comments acknowledge the current numeric `from/size` cursor is a simplification rather than proper `search_after`;
- embedding generation is synchronously coupled to semantic/hybrid query execution;
- result hydration only returns stable IDs/scores from this layer.

OS2/OS4 should separate the durable lexical/faceted requirement from optional semantic retrieval.

### 4.8 `src/search/embeddings/EmbeddingIngestWorker.ts`

**Classification: LEGACY/PROTOTYPE CANDIDATE pending OS2**

Evidence:

- comment identifies it as “V6.5 Phase 5.5”; 
- skip logic says a real system would hash text changes;
- `scanAndRetry()` is not implemented and only logs a message;
- mock embeddings are hard-coded to 1024 dimensions;
- client type is named around OpenSearch even though Qdrant is also present.

Do not invest in upgrading this worker until OS2 decides where embeddings belong and what the real embedding producer contract is.

### 4.9 Qdrant stack

Files/components include at least:

- `src/search/writer/QdrantClient.ts`;
- `src/search/service/QdrantBootstrapService.ts`;
- `src/feed/QdrantDocumentStore.ts`;
- `src/feed/QdrantHydrator.ts`;
- `src/feed/QdrantFeedProvider.ts`;
- `src/search/queries/QdrantFeedCandidateService.ts`;
- dedicated Qdrant tests.

**Classification: OS2 DECISION; current evidence says this is not dead code**

The Qdrant bootstrap creates a real cosine-vector collection with:

- configurable vector size (currently 1024);
- HNSW `m=16`, `ef_construct=100`;
- int8 scalar quantization at 0.99 quantile;
- payload indexes for time/tags/author/content identifiers/deletion/engagement.

The content client stores the full public-content payload with the dense vector and implements get/upsert/script-equivalent engagement updates/delete/delete-by-author.

This is substantial current functionality. OS2 must compare it with modern OpenSearch 3.8 rather than assuming Qdrant was abandoned.

### 4.10 `src/services/opensearch.ts`

**Classification: LEGACY CANDIDATE**

This is a separate older OpenSearch document model (`*-activities`) and mapping. It is wired to the old `StreamsService` concept and carries its own bulk indexer.

It is not the same model as `public-content-v1` / `public-author-v1`.

Notable positive behavior worth preserving conceptually in OS4: it already uses `refresh: false` and has a bulk indexing method. The newer client regressed to forced refresh for immediate visibility.

The code itself should not remain just to preserve those behaviors; OS4 should migrate the good batching/refresh semantics into the canonical search-indexer path.

### 4.11 `src/streams/index.ts` (`StreamsService`)

**Classification: LEGACY CANDIDATE**

Evidence:

- uses historical topic names `stream1-local-public`, `stream2-remote-public`, `firehose` rather than canonical V6 `ap.*.v1` topics;
- optionally takes the old `OpenSearchService` and starts its own Firehose->OpenSearch consumer;
- repository code search finds the class declaration/import relationship but no clear external construction path on current master;
- it duplicates responsibilities now covered by the V6 Redpanda/search stack.

Do not delete in OS1, but OS2/OS10 should prove it is unreachable and then archive/remove it.

### 4.12 `src/streams/opensearch-indexer.ts`

**Classification: LEGACY CANDIDATE**

This is another independent Firehose/tombstone consumer with:

- its own older `ActivityDocument` schema;
- its own 5-shard/1-replica index creation;
- separate batching/timer logic;
- direct OpenSearch client;
- duplicated public-search-consent handling.

`SearchIndexerService` explicitly warns that its consumer group must not be shared with the “opensearch-indexer legacy group”, which is strong internal evidence that this file is superseded.

OS10 should remove/archive it after CI/reference verification.

### 4.13 Redpanda Connect OpenSearch pipelines

Example: `redpanda-connect/streams/01-firehose-to-opensearch.yaml`.

**Classification: ALTERNATE PIPELINE / ownership decision required**

This path independently consumes `ap.firehose.v1` and bulk-indexes an `ap-activities` index with a fallback DLQ.

Positive qualities:

- bounded batching (`500` docs / `10s`);
- independent consumer group;
- idempotent document IDs;
- explicit OpenSearch failure fallback to a replayable DLQ.

Architectural issue:

- it duplicates the TypeScript `SearchIndexerService` public-content projection rather than sharing the `public-content-v1` mapping/projector;
- operating both would create separate indexes with different schemas and potentially inconsistent query semantics.

OS1 does **not** choose TypeScript versus Redpanda Connect as the final indexing implementation. OS4 must compare operational simplicity, mapping/projector correctness, backpressure, DLQ/replay, and testability, then designate exactly one canonical indexing path. Reusable reliability ideas should be migrated to the winner.

### 4.14 Media pipeline OpenSearch indexing

`media-pipeline-sidecar/src/indexing/openSearchMediaIndexer.ts` appears in the repository-wide OpenSearch inventory.

**Classification: RETAIN AS SEPARATE DOMAIN until audited in its own slice**

Media-derived public metadata/search is not automatically the same index responsibility as the AP/AT public-content projection. OS1 records it as an OpenSearch consumer but does not merge or delete it as part of the main public-content cleanup.

OS3 must at minimum verify client/version compatibility when OpenSearch is upgraded.

---

## 5. Canonical-vs-legacy ingestion map

Current repository shape:

```text
                              +------------------------------+
                              | Redpanda ap.firehose.v1      |
                              +------------------------------+
                                  |          |          |
                                  |          |          |
                    +-------------+          |          +------------------+
                    |                        |                             |
                    v                        v                             v
       SearchIndexerService       streams/opensearch-indexer     Redpanda Connect
       (newer V6 projection)       (legacy candidate)             01-firehose...
                    |                        |                             |
             +------+------+                |                             |
             |             |                v                             v
             v             v           older index                   ap-activities
        OpenSearch       Qdrant
     public-content-v1   public-content-v1
     public-author-v1

Historical parallel path:

StreamsService -> OpenSearchService -> <prefix>-activities
(old topic names; legacy candidate)
```

The target after OS2/OS4 must have **one canonical public-content indexing projection**, not four partially overlapping ones.

---

## 6. OS1 decisions

### Decision A — Keep OpenSearch, but narrow its guaranteed responsibility

Guaranteed OpenSearch responsibility entering OS2:

- rebuildable public full-text search;
- public facets/filters;
- public author search/lookup;
- public content read projection where OpenSearch is the selected document-query backend;
- no private content;
- no protocol or identity authority.

Not guaranteed entering OS2:

- vector storage;
- semantic retrieval;
- hybrid ranking;
- feed recommendation candidate generation;
- embedding production.

### Decision B — Do not upgrade historical paths independently

OS3 must not spend effort upgrading all OpenSearch implementations to 3.8.

Only paths that survive OS2/OS4 should receive production migration work. Legacy candidates may receive minimal compile/test adjustments only if required to keep the branch green until removal.

### Decision C — Qdrant must be evaluated as a real current architecture candidate

Because Qdrant is explicitly named the primary vector backend in V6 compose and has nontrivial current implementation/tests, OS2 must compare it with OpenSearch 3.8 rather than treating it as obsolete.

### Decision D — OpenSearch vector fields are provisional

The `1024`-dimension `knn_vector`, `16x` compression, embedding-status fields, OpenSearch hybrid pipeline, and synchronous query-embedding path are **not frozen architecture**.

### Decision E — Per-write refresh is known production debt

The newer OpenSearch client’s `refresh: true` behavior must be removed/tuned before resource or codec benchmarks.

### Decision F — Shard/replica counts are hypotheses

Current 1/3/5 shard counts across different generations are inconsistent. None is accepted as production sizing. OS5/OS8 will derive sizing from measured corpus and load.

---

## 7. OS2 questions that must be answered

OS2 is a **vector architecture decision**, not an OpenSearch feature migration.

Required comparisons:

1. **OpenSearch lexical/faceted only**
   - remove vectors from `public-content`;
   - Qdrant or another dedicated system owns semantic retrieval if still required.

2. **OpenSearch 3.8 lexical + vectors**
   - one search engine for BM25/facets/vector/hybrid;
   - measure current disk-based/memory-mapped/quantized vector behavior rather than extrapolating from OpenSearch 2.17.

3. **OpenSearch lexical/faceted + Qdrant vectors**
   - preserve specialized Qdrant vector collection;
   - establish a clean join/hydration boundary and avoid duplicate full-document ownership where possible.

4. **No vector responsibility in this repo’s public-query layer**
   - if recommendation/semantic search has moved to a separate canonical subsystem, remove the duplicate search-vector stack rather than maintaining it.

OS2 must also distinguish **public search** from **feed/recommendation candidate generation**. Those are different products and need not share the same retrieval engine.

---

## 8. OS2 evidence matrix

The next phase should inventory live call sites and then run a small controlled OpenSearch 3.8/Qdrant comparison before making the larger OS3 migration.

At minimum measure or establish:

| Concern | OpenSearch lexical only | OpenSearch 3.8 vector | OpenSearch + Qdrant |
|---|---:|---:|---:|
| Minimum idle memory | required | required | required |
| Public indexing CPU | required | required | required |
| Vector memory | n/a | required | required |
| Vector disk | n/a | required | required |
| Lexical p95/p99 | required | required | required |
| Vector p95/p99 | n/a | required | required |
| Hybrid p95/p99 | external/optional | required | required |
| Ingest throughput | required | required | required |
| Operational components | 1 | 1 | 2 |
| Replay/rebuild complexity | required | required | required |
| Failure isolation | required | required | required |
| Query/result equivalence | baseline | required | required |

No production choice should be based solely on vendor benchmark numbers.

---

## 9. Follow-on phase order

The OpenSearch program remains:

1. **OS1 — Responsibility/legacy audit** — this document.
2. **OS2 — Vector architecture audit and measured decision.**
3. **OS3 — Upgrade surviving OpenSearch path(s) to 3.8.**
4. **OS4 — Canonical ingestion path, batching, refresh, backpressure and replay hardening.**
5. **OS5 — Minimum-resource/topology benchmark.**
6. **OS6 — Stored-field codec/level benchmark (LZ4 vs Zstd/Zstd-no-dict).**
7. **OS7 — `_source`/derived-source/vector-storage optimization.**
8. **OS8 — Shards, replicas, rollover, retention and snapshots.**
9. **OS9 — Whole-stack cost/performance benchmark.**
10. **OS10 — Remove/archive proven legacy paths and finalize architecture docs.**

OS2 and OS3 must remain separate: upgrading first would spend effort migrating vector/hybrid code that may be intentionally removed.

---

## 10. OS1 completion criteria

OS1 is complete when this audit is reviewed and the following are accepted as the next-phase baseline:

- OpenSearch is Tier-3 rebuildable public-query infrastructure only;
- the current vector/hybrid mapping is provisional;
- Qdrant is an active comparison candidate, not presumed dead code;
- `SearchIndexerService` is the leading canonical projection candidate but not yet frozen;
- old `OpenSearchService` / `StreamsService` / `OpenSearchIndexer` paths are explicit legacy-removal candidates;
- Redpanda Connect is an alternate ingestion implementation whose useful batching/DLQ properties must be considered before choosing the canonical indexer;
- per-write forced refresh and inconsistent shard counts are known benchmark blockers;
- no codec/compression setting should be selected until OS2-OS5 establish the correct surviving topology and an efficient ingestion baseline.
