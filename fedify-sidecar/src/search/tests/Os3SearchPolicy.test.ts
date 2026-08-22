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
    const update = vi.fn(async (_args: Record<string, unknown>) => ({ body: {} }));
    const deleteDocument = vi.fn(async (_args: Record<string, unknown>) => ({ body: {} }));
    const deleteByQuery = vi.fn(async (_args: Record<string, unknown>) => ({ body: {} }));
    const client = {
      update,
      delete: deleteDocument,
      deleteByQuery,
    };
    const store = new DefaultOpenSearchClient(client as any);

    await store.upsert('doc-1', { stableDocId: 'doc-1' } as any);
    await store.updateScripted('doc-1', 'ctx._source.x += params.delta', { delta: 1 });
    await store.delete('doc-1');
    await store.deleteByAuthor({ canonicalId: 'actor-1' });

    for (const [args] of update.mock.calls) {
      expect(args).not.toHaveProperty('refresh');
    }
    expect(deleteDocument.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
    expect(deleteByQuery.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
  });

  it('does not force an OpenSearch refresh for author mutations', async () => {
    const update = vi.fn(async (_args: Record<string, unknown>) => ({ body: {} }));
    const deleteDocument = vi.fn(async (_args: Record<string, unknown>) => ({ body: {} }));
    const client = {
      update,
      delete: deleteDocument,
    };
    const store = new DefaultOpenSearchAuthorClient(client as any);

    await store.upsert('actor-1', { stableAuthorId: 'actor-1' } as any);
    await store.delete('actor-1');

    expect(update.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
    expect(deleteDocument.mock.calls[0]?.[0]).not.toHaveProperty('refresh');
  });
});
