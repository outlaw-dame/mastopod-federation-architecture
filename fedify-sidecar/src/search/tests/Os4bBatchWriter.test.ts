import { describe, expect, it, vi } from 'vitest';
import { PublicContentBatchError, PublicContentIndexWriter, type PublicContentStore } from '../writer/PublicContentIndexWriter.js';
import { InMemoryOpenSearchClient } from '../writer/OpenSearchClient.js';
import { InMemorySearchDocAliasCache, type SearchDocAliasCache } from '../writer/SearchDocAliasCache.js';
import { DefaultSearchDedupService } from '../aliases/SearchDedupService.js';
import type { SearchPublicUpsertV1 } from '../events/SearchEvents.js';

function event(id: string): SearchPublicUpsertV1 {
  return {
    upsertKind: 'full',
    stableDocId: `ap:https://example.test/posts/${id}`,
    protocolSource: 'ap',
    sourceKind: 'remote',
    ap: { objectUri: `https://example.test/posts/${id}` },
    author: { apUri: 'https://example.test/users/a' },
    content: { text: `post ${id}`, createdAt: '2026-08-22T00:00:00.000Z' },
    indexedAt: '2026-08-22T00:00:00.000Z',
  };
}

function writer(store: PublicContentStore, aliases: SearchDocAliasCache = new InMemorySearchDocAliasCache()) {
  return { writer: new PublicContentIndexWriter(store, aliases, new DefaultSearchDedupService(aliases)), aliases };
}

describe('OS4b ordered batch writer', () => {
  it('uses one bulk fast path for fresh unique documents', async () => {
    const store = new InMemoryOpenSearchClient();
    const getMany = vi.spyOn(store, 'getMany');
    const upsertMany = vi.spyOn(store, 'upsertMany');
    const { writer: target, aliases } = writer(store);

    await target.onUpsertBatch([event('1'), event('2'), event('3')]);

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(upsertMany).toHaveBeenCalledTimes(1);
    expect(store.getAll()).toHaveLength(3);
    expect(await aliases.getByApUri('https://example.test/posts/2')).toBe('ap:https://example.test/posts/2');
  });

  it('keeps duplicate target IDs on the sequential merge path', async () => {
    const store = new InMemoryOpenSearchClient();
    const upsertMany = vi.spyOn(store, 'upsertMany');
    const { writer: target } = writer(store);
    const duplicateA = event('same');
    const duplicateB = { ...event('same'), content: { ...event('same').content, text: 'changed text' } };

    await target.onUpsertBatch([duplicateA, duplicateB]);

    expect(upsertMany).not.toHaveBeenCalled();
    expect(store.getAll()).toHaveLength(1);
  });

  it('reports the exact first failed bulk source index and reconciles every successful item alias', async () => {
    const docs = new Map<string, any>();
    const store: PublicContentStore = {
      get: async (id) => docs.get(id) ?? null,
      getMany: async (ids) => new Map(ids.map((id) => [id, null])),
      upsert: async (id, doc) => { docs.set(id, doc); },
      upsertMany: async (entries) => entries.map((entry, i) => {
        if (i === 1) return { ok: false, error: new Error('synthetic item failure') };
        docs.set(entry.id, entry.doc);
        return { ok: true };
      }),
      updateScripted: async () => undefined,
      delete: async () => undefined,
      deleteByAuthor: async () => undefined,
    };
    const { writer: target, aliases } = writer(store);

    let failure: unknown;
    try { await target.onUpsertBatch([event('a'), event('b'), event('c')]); }
    catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(PublicContentBatchError);
    expect((failure as PublicContentBatchError).failedIndex).toBe(1);
    expect(await aliases.getByApUri('https://example.test/posts/a')).toBe('ap:https://example.test/posts/a');
    expect(await aliases.getByApUri('https://example.test/posts/b')).toBeNull();
    expect(await aliases.getByApUri('https://example.test/posts/c')).toBe('ap:https://example.test/posts/c');
    expect(docs.has('ap:https://example.test/posts/c')).toBe(true);
  });

  it('heals a successful suffix alias on replay when an earlier bulk item failed', async () => {
    const docs = new Map<string, any>();
    const bulkWrittenIds: string[] = [];
    const sequentialWrittenIds: string[] = [];
    let bulkCall = 0;
    const store: PublicContentStore = {
      get: async (id) => docs.get(id) ?? null,
      getMany: async (ids) => new Map(ids.map((id) => [id, docs.get(id) ?? null])),
      upsert: async (id, doc) => {
        sequentialWrittenIds.push(id);
        docs.set(id, doc);
      },
      upsertMany: async (entries) => {
        bulkCall += 1;
        return entries.map((entry, i) => {
          if (bulkCall === 1 && i === 1) {
            return { ok: false, error: new Error('synthetic middle item failure') };
          }
          docs.set(entry.id, entry.doc);
          bulkWrittenIds.push(entry.id);
          return { ok: true };
        });
      },
      updateScripted: async () => undefined,
      delete: async () => undefined,
      deleteByAuthor: async () => undefined,
    };

    const backingAliases = new InMemorySearchDocAliasCache();
    let failSuffixAliasOnce = true;
    const aliases: SearchDocAliasCache = {
      getByCanonicalId: (id) => backingAliases.getByCanonicalId(id),
      getByApUri: (uri) => backingAliases.getByApUri(uri),
      getByAtUri: (uri) => backingAliases.getByAtUri(uri),
      setCanonicalId: (id, stableDocId) => backingAliases.setCanonicalId(id, stableDocId),
      setApUri: async (uri, stableDocId) => {
        if (uri === 'https://example.test/posts/c' && failSuffixAliasOnce) {
          failSuffixAliasOnce = false;
          throw new Error('synthetic suffix alias failure');
        }
        await backingAliases.setApUri(uri, stableDocId);
      },
      setAtUri: (uri, stableDocId) => backingAliases.setAtUri(uri, stableDocId),
    };
    const { writer: target } = writer(store, aliases);
    const batch = [event('a'), event('b'), event('c')];

    let firstFailure: unknown;
    try { await target.onUpsertBatch(batch); }
    catch (error) { firstFailure = error; }

    expect(firstFailure).toBeInstanceOf(PublicContentBatchError);
    expect((firstFailure as PublicContentBatchError).failedIndex).toBe(1);
    expect(await aliases.getByApUri('https://example.test/posts/c')).toBeNull();
    expect(docs.has('ap:https://example.test/posts/c')).toBe(true);

    await target.onUpsertBatch(batch);

    expect(await aliases.getByApUri('https://example.test/posts/a')).toBe('ap:https://example.test/posts/a');
    expect(await aliases.getByApUri('https://example.test/posts/b')).toBe('ap:https://example.test/posts/b');
    expect(await aliases.getByApUri('https://example.test/posts/c')).toBe('ap:https://example.test/posts/c');
    expect(docs.size).toBe(3);
    expect(bulkWrittenIds.filter((id) => id === 'ap:https://example.test/posts/c')).toHaveLength(1);
    expect(sequentialWrittenIds).not.toContain('ap:https://example.test/posts/c');
  });

  it('does not publish aliases when the bulk request itself fails', async () => {
    const store: PublicContentStore = {
      get: async () => null,
      getMany: async (ids) => new Map(ids.map((id) => [id, null])),
      upsert: async () => undefined,
      upsertMany: async () => { throw new Error('transport down'); },
      updateScripted: async () => undefined,
      delete: async () => undefined,
      deleteByAuthor: async () => undefined,
    };
    const { writer: target, aliases } = writer(store);

    await expect(target.onUpsertBatch([event('x'), event('y')])).rejects.toBeInstanceOf(PublicContentBatchError);
    expect(await aliases.getByApUri('https://example.test/posts/x')).toBeNull();
    expect(await aliases.getByApUri('https://example.test/posts/y')).toBeNull();
  });
});
