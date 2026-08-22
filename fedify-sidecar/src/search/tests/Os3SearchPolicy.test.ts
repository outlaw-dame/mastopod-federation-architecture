import { describe, expect, it, vi } from 'vitest';
import { resolveSearchBackend } from '../../config/v6-config.js';
import { DefaultOpenSearchAuthorClient, DefaultOpenSearchClient } from '../writer/OpenSearchClient.js';

describe('OS3 search runtime policy', () => {
  it('defaults to OpenSearch and preserves explicit experimental overrides', () => {
    expect(resolveSearchBackend(undefined)).toBe('opensearch');
    expect(resolveSearchBackend('garbage')).toBe('opensearch');
    expect(resolveSearchBackend('opensearch')).toBe('opensearch');
    expect(resolveSearchBackend('qdrant')).toBe('qdrant');
    expect(resolveSearchBackend('dual')).toBe('dual');
  });

  it('does not force an OpenSearch refresh for normal content mutations', async () => {
    const client = {
      update: vi.fn(async () => ({ body: {} })),
      delete: vi.fn(async () => ({ body: {} })),
      deleteByQuery: vi.fn(async () => ({ body: {} })),
    };
    const store = new DefaultOpenSearchClient(client as any);

    await store.upsert('doc-1', { stableDocId: 'doc-1' } as any);
    await store.updateScripted('doc-1', 'ctx._source.x += params.delta', { delta: 1 });
    await store.delete('doc-1');
    await store.deleteByAuthor({ canonicalId: 'actor-1' });

    for (const call of client.update.mock.calls) {
      expect(call[0]).not.toHaveProperty('refresh');
    }
    expect(client.delete.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
    expect(client.deleteByQuery.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
  });

  it('does not force an OpenSearch refresh for author mutations', async () => {
    const client = {
      update: vi.fn(async () => ({ body: {} })),
      delete: vi.fn(async () => ({ body: {} })),
    };
    const store = new DefaultOpenSearchAuthorClient(client as any);

    await store.upsert('actor-1', { stableAuthorId: 'actor-1' } as any);
    await store.delete('actor-1');

    expect(client.update.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
    expect(client.delete.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
  });
});
