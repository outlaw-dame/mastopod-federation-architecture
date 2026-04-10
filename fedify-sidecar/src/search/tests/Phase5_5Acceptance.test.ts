/// <reference types="vitest/globals" />
/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * Acceptance Tests
 */

import { DefaultSearchDedupService } from '../aliases/SearchDedupService.js';
import { PublicContentIndexWriter } from '../writer/PublicContentIndexWriter.js';
import { InMemoryOpenSearchClient } from '../writer/OpenSearchClient.js';
import { InMemorySearchDocAliasCache } from '../writer/SearchDocAliasCache.js';
import { SearchPublicUpsertV1 } from '../events/SearchEvents.js';
import { EmbeddingIngestWorker, MockEmbeddingService } from '../embeddings/EmbeddingIngestWorker.js';
import { HybridQueryBuilder } from '../queries/HybridQueryBuilder.js';

describe('Phase 5.5 Acceptance Tests', () => {
  let osClient: InMemoryOpenSearchClient;
  let aliasCache: InMemorySearchDocAliasCache;
  let dedupService: DefaultSearchDedupService;
  let writer: PublicContentIndexWriter;
  let embeddingWorker: EmbeddingIngestWorker;
  let queryBuilder: HybridQueryBuilder;

  beforeEach(() => {
    osClient = new InMemoryOpenSearchClient();
    aliasCache = new InMemorySearchDocAliasCache();
    dedupService = new DefaultSearchDedupService(aliasCache);
    writer = new PublicContentIndexWriter(osClient, aliasCache, dedupService);
    embeddingWorker = new EmbeddingIngestWorker(osClient, new MockEmbeddingService());
    queryBuilder = new HybridQueryBuilder();
  });

  it('Test 1 — Dedup Service: Local deterministic merge', async () => {
    const upsert1: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId: 'post1',
      canonicalContentId: 'post1',
      protocolSource: 'ap',
      sourceKind: 'local',
      author: { canonicalId: 'user1' },
      content: { text: 'Hello', createdAt: new Date().toISOString() },
      indexedAt: new Date().toISOString()
    };

    const upsert2: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId: 'post1',
      canonicalContentId: 'post1',
      protocolSource: 'at',
      sourceKind: 'local',
      author: { canonicalId: 'user1' },
      content: { text: 'Hello', createdAt: new Date().toISOString() },
      indexedAt: new Date().toISOString()
    };

    await writer.onUpsert(upsert1);
    await writer.onUpsert(upsert2);

    const docs = osClient.getAll();
    expect(docs.length).toBe(1);
    expect(docs[0]!.protocolPresence).toContain('ap');
    expect(docs[0]!.protocolPresence).toContain('at');
  });

  it('Test 2 — Dedup Service: Conservative remote merge', async () => {
    const now = new Date().toISOString();
    
    const upsert1: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId: 'ap:remote1',
      protocolSource: 'ap',
      sourceKind: 'remote',
      ap: { objectUri: 'remote1' },
      author: { canonicalId: 'user1' },
      content: { text: 'Remote content', createdAt: now },
      indexedAt: now
    };

    const upsert2: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId: 'at:remote1',
      protocolSource: 'at',
      sourceKind: 'remote',
      at: { uri: 'remote1', did: 'did:plc:123' },
      author: { canonicalId: 'user1' }, // Same author
      content: { text: 'Remote content', createdAt: now }, // Same text
      indexedAt: now
    };

    // We need to simulate the alias cache pointing to the same doc to trigger the merge check
    await aliasCache.setAtUri('remote1', 'ap:remote1');

    await writer.onUpsert(upsert1);
    await writer.onUpsert(upsert2);

    const docs = osClient.getAll();
    // Should merge because author, text, and time match
    expect(docs.length).toBe(1);
    expect(docs[0]!.protocolPresence).toContain('ap');
    expect(docs[0]!.protocolPresence).toContain('at');
  });

  it('Test 3 — Dedup Service: Reject unsafe remote merge', async () => {
    const now = new Date().toISOString();
    
    const upsert1: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId: 'ap:remote2',
      protocolSource: 'ap',
      sourceKind: 'remote',
      ap: { objectUri: 'remote2' },
      author: { canonicalId: 'user1' },
      content: { text: 'Remote content', createdAt: now },
      indexedAt: now
    };

    const upsert2: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId: 'at:remote2',
      protocolSource: 'at',
      sourceKind: 'remote',
      at: { uri: 'remote2', did: 'did:plc:123' },
      author: { canonicalId: 'user1' },
      content: { text: 'Completely different text', createdAt: now }, // Different text
      indexedAt: now
    };

    // We need to simulate the alias cache pointing to the same doc to trigger the merge check
    await aliasCache.setAtUri('remote2', 'ap:remote2');

    await writer.onUpsert(upsert1);
    await writer.onUpsert(upsert2);

    const docs = osClient.getAll();
    // Should NOT merge because text is different
    // The writer will skip the second upsert to avoid corruption
    expect(docs.length).toBe(1);
    expect(docs[0]!.protocolPresence).toEqual(['ap']);
  });

  it('Test 4 — Embedding Worker', async () => {
    const upsert: SearchPublicUpsertV1 = {
      upsertKind: 'full',
      stableDocId: 'post3',
      canonicalContentId: 'post3',
      protocolSource: 'ap',
      sourceKind: 'local',
      author: { canonicalId: 'user1' },
      content: { text: 'Embed me', createdAt: new Date().toISOString() },
      indexedAt: new Date().toISOString()
    };

    await writer.onUpsert(upsert);
    
    let doc = await osClient.get('post3');
    expect(doc!.embedding).toBeUndefined();

    await embeddingWorker.processDocument('post3');

    doc = await osClient.get('post3');
    expect(doc!.embedding).toBeDefined();
    expect(doc!.embedding!.length).toBe(1024);
  });

  it('Test 5 — Hybrid Query Builder', () => {
    const query = 'test query';
    const vector = new Array(1024).fill(0.1);
    
    const hybridQuery = queryBuilder.buildHybridQuery(query, vector);
    
    expect(hybridQuery.query.hybrid.queries.length).toBe(2);
    expect((hybridQuery.query.hybrid.queries[0] as any).bool.must[0].multi_match.query).toBe(query);
    expect((hybridQuery.query.hybrid.queries[1] as any).knn.embedding.vector).toBe(vector);
  });
});
