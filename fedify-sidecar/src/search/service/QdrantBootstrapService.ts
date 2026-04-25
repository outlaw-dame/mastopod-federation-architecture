import { logger } from '../../utils/logger.js';

export interface QdrantBootstrapConfig {
  qdrantUrl: string;
  qdrantApiKey?: string;
  collectionName: string;
  vectorSize: number;
  requestTimeoutMs: number;
}

export class QdrantBootstrapService {
  constructor(private readonly config: QdrantBootstrapConfig) {}

  async bootstrap(): Promise<void> {
    await this.ensureCollection();
    await this.ensurePayloadIndex('createdAt', 'datetime');
    await this.ensurePayloadIndex('tags', 'keyword');
    await this.ensurePayloadIndex('author.canonicalId', 'keyword');
    await this.ensurePayloadIndex('author.apUri', 'keyword');
    await this.ensurePayloadIndex('author.did', 'keyword');
    await this.ensurePayloadIndex('author.handle', 'keyword');
    await this.ensurePayloadIndex('canonicalContentId', 'keyword');
    await this.ensurePayloadIndex('ap.objectUri', 'keyword');
    await this.ensurePayloadIndex('isDeleted', 'bool');
    await this.ensurePayloadIndex('engagement.likeCount', 'integer');
    await this.ensurePayloadIndex('engagement.repostCount', 'integer');
    logger.info('[QdrantBootstrap] Bootstrap complete', {
      collection: this.config.collectionName,
      vectorSize: this.config.vectorSize,
    });
  }

  private async ensureCollection(): Promise<void> {
    const existing = await this.request(
      'GET',
      `/collections/${encodeURIComponent(this.config.collectionName)}`,
      undefined,
      true,
    );

    if (existing) {
      logger.info('[QdrantBootstrap] Collection already exists', {
        collection: this.config.collectionName,
      });
      return;
    }

    await this.request('PUT', `/collections/${encodeURIComponent(this.config.collectionName)}`, {
      vectors: {
        size: this.config.vectorSize,
        distance: 'Cosine',
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100,
      },
      quantization_config: {
        scalar: {
          type: 'int8',
          quantile: 0.99,
          always_ram: true,
        },
      },
    });

    logger.info('[QdrantBootstrap] Collection created', {
      collection: this.config.collectionName,
    });
  }

  private async ensurePayloadIndex(fieldName: string, fieldSchema: string): Promise<void> {
    try {
      await this.request('PUT', `/collections/${encodeURIComponent(this.config.collectionName)}/index`, {
        field_name: fieldName,
        field_schema: fieldSchema,
      });
    } catch (error) {
      logger.warn('[QdrantBootstrap] Payload index create skipped', {
        collection: this.config.collectionName,
        fieldName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    swallowNotFound = false,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(`${this.config.qdrantUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.config.qdrantApiKey ? { 'api-key': this.config.qdrantApiKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (swallowNotFound && response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Qdrant bootstrap request failed (${response.status} ${response.statusText}): ${responseText}`);
      }

      if (response.status === 204) {
        return null;
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createQdrantBootstrapConfig(): QdrantBootstrapConfig {
  return {
    qdrantUrl: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
    qdrantApiKey: process.env['QDRANT_API_KEY'],
    collectionName: process.env['QDRANT_COLLECTION_NAME'] ?? 'public-content-v1',
    vectorSize: parseInt(process.env['QDRANT_VECTOR_SIZE'] ?? '1024', 10),
    requestTimeoutMs: parseInt(process.env['QDRANT_REQUEST_TIMEOUT_MS'] ?? '5000', 10),
  };
}