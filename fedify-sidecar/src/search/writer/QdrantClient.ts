import { logger } from '../../utils/logger.js';
import { PublicContentDocument } from '../models/PublicContentDocument.js';
import type { PublicContentStore } from './PublicContentIndexWriter.js';

export interface QdrantClientConfig {
  baseUrl: string;
  apiKey?: string;
  collectionName: string;
  vectorSize: number;
  requestTimeoutMs: number;
}

type QdrantPointRecord = {
  id: string | number;
  payload?: Record<string, unknown>;
  vector?: number[] | Record<string, number[]>;
};

type QdrantPointResponse = {
  result?: QdrantPointRecord;
};

export class DefaultQdrantContentClient implements PublicContentStore {
  constructor(private readonly config: QdrantClientConfig) {}

  async get(id: string): Promise<PublicContentDocument | null> {
    const response = await this.request<QdrantPointResponse>(
      'GET',
      `/collections/${encodeURIComponent(this.config.collectionName)}/points/${encodeURIComponent(id)}?with_payload=true&with_vector=true`,
      undefined,
      true,
    );

    if (!response?.result?.payload) {
      return null;
    }

    return this.mapPointToDocument(response.result);
  }

  async upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void> {
    const existing = await this.get(id);
    const merged = mergePublicContentDocument(existing, doc, id);
    const denseVector = normalizeDenseVector(merged.embedding, this.config.vectorSize);

    await this.request('PUT', `/collections/${encodeURIComponent(this.config.collectionName)}/points?wait=true`, {
      points: [
        {
          id,
          vector: denseVector,
          payload: merged,
        },
      ],
    });
  }

  async updateScripted(id: string, _script: string, params: Record<string, any>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      return;
    }

    const engagement = {
      likeCount: clampCounter((existing.engagement?.likeCount ?? 0) + Number(params['likeDelta'] ?? 0)),
      repostCount: clampCounter((existing.engagement?.repostCount ?? 0) + Number(params['repostDelta'] ?? 0)),
      replyCount: clampCounter((existing.engagement?.replyCount ?? 0) + Number(params['replyDelta'] ?? 0)),
    };

    await this.upsert(id, {
      ...existing,
      engagement,
      indexedAt: typeof params['indexedAt'] === 'string' ? params['indexedAt'] : existing.indexedAt,
    });
  }

  async delete(id: string): Promise<void> {
    await this.request(
      'POST',
      `/collections/${encodeURIComponent(this.config.collectionName)}/points/delete?wait=true`,
      { points: [id] },
      true,
    );
  }

  async deleteByAuthor(author: {
    canonicalId?: string;
    apUri?: string;
    did?: string;
    handle?: string;
  }): Promise<void> {
    const should: Array<Record<string, unknown>> = [];

    if (author.canonicalId) {
      should.push({ key: 'author.canonicalId', match: { value: author.canonicalId } });
    }
    if (author.apUri) {
      should.push({ key: 'author.apUri', match: { value: author.apUri } });
    }
    if (author.did) {
      should.push({ key: 'author.did', match: { value: author.did } });
    }
    if (author.handle) {
      should.push({ key: 'author.handle', match: { value: author.handle } });
    }

    if (should.length === 0) {
      return;
    }

    await this.request('POST', `/collections/${encodeURIComponent(this.config.collectionName)}/points/delete?wait=true`, {
      filter: {
        should,
        min_should: 1,
      },
    });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    swallowNotFound = false,
  ): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { 'api-key': this.config.apiKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (swallowNotFound && response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Qdrant request failed (${response.status} ${response.statusText}): ${responseText}`);
      }

      if (response.status === 204) {
        return null;
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error('[QdrantContentClient] Request failed', {
        method,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private mapPointToDocument(point: QdrantPointRecord): PublicContentDocument {
    const payload = (point.payload ?? {}) as unknown as Partial<PublicContentDocument>;
    const vector = point.vector;

    const denseEmbedding = Array.isArray(vector)
      ? vector
      : Array.isArray((vector as Record<string, number[]> | undefined)?.['dense'])
        ? (vector as Record<string, number[]>)['dense']
        : payload.embedding;

    return {
      ...payload,
      stableDocId: payload.stableDocId ?? String(point.id),
      protocolPresence: payload.protocolPresence ?? [],
      sourceKind: payload.sourceKind ?? 'remote',
      author: payload.author ?? {},
      text: payload.text ?? '',
      createdAt: payload.createdAt ?? new Date(0).toISOString(),
      hasMedia: payload.hasMedia ?? false,
      mediaCount: payload.mediaCount ?? 0,
      isDeleted: payload.isDeleted ?? false,
      indexedAt: payload.indexedAt ?? new Date().toISOString(),
      embedding: denseEmbedding,
    };
  }
}

function mergePublicContentDocument(
  existing: PublicContentDocument | null,
  patch: Partial<PublicContentDocument>,
  fallbackId: string,
): PublicContentDocument {
  const ap = mergeApFields(existing?.ap, patch.ap);
  const at = mergeAtFields(existing?.at, patch.at);

  return {
    ...(existing ?? createEmptyDocument(fallbackId)),
    ...patch,
    stableDocId: patch.stableDocId ?? existing?.stableDocId ?? fallbackId,
    ...(ap ? { ap } : {}),
    ...(at ? { at } : {}),
    author: {
      ...(existing?.author ?? {}),
      ...(patch.author ?? {}),
    },
    engagement: {
      ...(existing?.engagement ?? {}),
      ...(patch.engagement ?? {}),
    },
    ranking: {
      ...(existing?.ranking ?? {}),
      ...(patch.ranking ?? {}),
    },
  };
}

function createEmptyDocument(stableDocId: string): PublicContentDocument {
  return {
    stableDocId,
    protocolPresence: [],
    sourceKind: 'remote',
    author: {},
    text: '',
    createdAt: new Date(0).toISOString(),
    hasMedia: false,
    mediaCount: 0,
    isDeleted: false,
    indexedAt: new Date().toISOString(),
  };
}

function mergeApFields(
  existing: PublicContentDocument['ap'],
  patch: PublicContentDocument['ap'] | undefined,
): PublicContentDocument['ap'] | undefined {
  const merged: Partial<NonNullable<PublicContentDocument['ap']>> = {
    ...(existing ?? {}),
    ...(patch ?? {}),
  };

  if (typeof merged.objectUri !== 'string' || merged.objectUri.length === 0) {
    return undefined;
  }

  return {
    objectUri: merged.objectUri,
    ...(typeof merged.activityUri === 'string' && merged.activityUri.length > 0
      ? { activityUri: merged.activityUri }
      : {}),
  };
}

function mergeAtFields(
  existing: PublicContentDocument['at'],
  patch: PublicContentDocument['at'] | undefined,
): PublicContentDocument['at'] | undefined {
  const merged: Partial<NonNullable<PublicContentDocument['at']>> = {
    ...(existing ?? {}),
    ...(patch ?? {}),
  };

  if (
    typeof merged.uri !== 'string' ||
    merged.uri.length === 0 ||
    typeof merged.did !== 'string' ||
    merged.did.length === 0
  ) {
    return undefined;
  }

  return {
    uri: merged.uri,
    did: merged.did,
    ...(typeof merged.cid === 'string' && merged.cid.length > 0 ? { cid: merged.cid } : {}),
  };
}

function normalizeDenseVector(vector: number[] | undefined, size: number): number[] {
  if (!vector || vector.length === 0) {
    return new Array(size).fill(0);
  }

  if (vector.length !== size) {
    throw new Error(`Qdrant vector dimension mismatch: expected ${size}, received ${vector.length}`);
  }

  return vector;
}

function clampCounter(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1_000_000_000, Math.trunc(value)));
}

export class NoopPublicAuthorStore {
  async get(): Promise<null> {
    return null;
  }

  async upsert(): Promise<void> {
    return undefined;
  }

  async delete(): Promise<void> {
    return undefined;
  }
}