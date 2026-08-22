/**
 * OpenSearchBootstrapService
 *
 * OS3 canonical bootstrap for the rebuildable Tier-3 public query projection.
 * Current runtime requirements are lexical/faceted only, so bootstrap creates
 * only the public content and author indices. Historical embedding ingest and
 * hybrid-search pipelines are intentionally not created.
 */

import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import { PublicContentMapping } from '../mappings/PublicContentMapping.js';
import { PublicAuthorMapping } from '../mappings/PublicAuthorMapping.js';
import { logger } from '../../utils/logger.js';

export interface OpenSearchBootstrapConfig {
  opensearchUrl: string;
  opensearchUsername?: string;
  opensearchPassword?: string;
  opensearchSslVerify: boolean;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  bootstrapTimeoutMs: number;
}

const CONTENT_INDEX = 'public-content-v1';
const AUTHOR_INDEX = 'public-author-v1';

export class OpenSearchBootstrapService {
  private client: OpenSearchNativeClient;

  constructor(private readonly config: OpenSearchBootstrapConfig) {
    const clientOpts: Record<string, unknown> = {
      node: config.opensearchUrl,
      ssl: { rejectUnauthorized: config.opensearchSslVerify },
      requestTimeout: 30_000,
      maxRetries: 0,
    };

    if (config.opensearchUsername) {
      clientOpts['auth'] = {
        username: config.opensearchUsername,
        password: config.opensearchPassword ?? '',
      };
    }

    this.client = new OpenSearchNativeClient(clientOpts);
  }

  async bootstrap(): Promise<void> {
    const deadline = Date.now() + this.config.bootstrapTimeoutMs;

    logger.info('[OpenSearchBootstrap] Starting lexical/faceted bootstrap', {
      url: this.config.opensearchUrl,
      maxRetries: this.config.maxRetries,
      bootstrapTimeoutMs: this.config.bootstrapTimeoutMs,
    });

    await this.waitForCluster(deadline);
    await this.ensureIndex(CONTENT_INDEX, PublicContentMapping, deadline);
    await this.ensureIndex(AUTHOR_INDEX, PublicAuthorMapping, deadline);

    logger.info('[OpenSearchBootstrap] Bootstrap complete', {
      vectorSearchEnabled: false,
      hybridPipelineEnabled: false,
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async waitForCluster(deadline: number): Promise<void> {
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      this.assertDeadline(deadline, 'waitForCluster');

      try {
        const response = await this.client.cluster.health({
          wait_for_status: 'yellow',
          timeout: '10s',
        });
        const status = response.body?.['status'];
        if (status === 'yellow' || status === 'green') {
          logger.info('[OpenSearchBootstrap] Cluster healthy', { status });
          return;
        }
        logger.warn('[OpenSearchBootstrap] Cluster status not ready', { status });
      } catch (error: unknown) {
        logger.warn('[OpenSearchBootstrap] Cluster health check failed', {
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      attempt += 1;
      if (attempt < this.config.maxRetries) {
        await this.backoff(attempt, deadline);
      }
    }

    throw new Error(
      `[OpenSearchBootstrap] Cluster not reachable after ${this.config.maxRetries} attempts`,
    );
  }

  private async ensureIndex(
    indexName: string,
    mapping: { settings: Record<string, unknown>; mappings: Record<string, unknown> },
    deadline: number,
  ): Promise<void> {
    await this.retryableOperation(`ensureIndex(${indexName})`, deadline, async () => {
      const exists = await this.client.indices.exists({ index: indexName });
      if (exists.body === true) {
        logger.info('[OpenSearchBootstrap] Index already exists', { index: indexName });
        if (indexName === CONTENT_INDEX) {
          await this.clearLegacyDefaultPipeline(indexName);
        }
        await this.safeUpdateMappings(indexName, mapping.mappings);
        return;
      }

      await this.client.indices.create({
        index: indexName,
        body: {
          settings: mapping.settings,
          mappings: mapping.mappings,
        },
      });
      logger.info('[OpenSearchBootstrap] Index created', { index: indexName });
    });
  }

  /**
   * Older public-content-v1 indices may still point at the Phase 5.5 embedding
   * ingest pipeline. OpenSearch uses `_none` to explicitly disable a default
   * pipeline. Clearing it is required before operators can safely remove the
   * obsolete pipeline and prevents legacy embedding-status mutation on new
   * lexical-only documents.
   */
  private async clearLegacyDefaultPipeline(indexName: string): Promise<void> {
    await this.client.indices.putSettings({
      index: indexName,
      body: {
        index: {
          default_pipeline: '_none',
        },
      },
    });
    logger.info('[OpenSearchBootstrap] Cleared legacy default ingest pipeline', {
      index: indexName,
    });
  }

  private async safeUpdateMappings(
    indexName: string,
    mappings: Record<string, unknown>,
  ): Promise<void> {
    try {
      const properties = (mappings as { properties?: Record<string, unknown> }).properties;
      if (!properties) return;
      await this.client.indices.putMapping({
        index: indexName,
        body: { properties },
      });
      logger.debug('[OpenSearchBootstrap] Mappings updated (additive)', { index: indexName });
    } catch (error: unknown) {
      logger.warn('[OpenSearchBootstrap] Additive mapping update rejected', {
        index: indexName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async retryableOperation(
    operationName: string,
    deadline: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      this.assertDeadline(deadline, operationName);
      try {
        await operation();
        return;
      } catch (error: unknown) {
        attempt += 1;
        if (attempt >= this.config.maxRetries) {
          logger.error(`[OpenSearchBootstrap] ${operationName} failed after max retries`, {
            attempts: attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        await this.backoff(attempt, deadline);
      }
    }
  }

  private async backoff(attempt: number, deadline: number): Promise<void> {
    this.assertDeadline(deadline, 'backoff');
    const exponential = Math.min(
      this.config.baseRetryDelayMs * 2 ** Math.max(0, attempt - 1),
      this.config.maxRetryDelayMs,
    );
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.2)));
    const delay = Math.min(exponential + jitter, Math.max(0, deadline - Date.now()));
    if (delay <= 0) {
      this.assertDeadline(deadline, 'backoff');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private assertDeadline(deadline: number, operationName: string): void {
    if (Date.now() >= deadline) {
      throw new Error(`[OpenSearchBootstrap] Bootstrap deadline exceeded during ${operationName}`);
    }
  }
}

export function createOpenSearchBootstrapConfig(): OpenSearchBootstrapConfig {
  return {
    opensearchUrl: process.env['OPENSEARCH_URL'] ?? 'http://localhost:9200',
    opensearchUsername: process.env['OPENSEARCH_USERNAME'],
    opensearchPassword: process.env['OPENSEARCH_PASSWORD'],
    opensearchSslVerify: process.env['OPENSEARCH_SSL_VERIFY'] !== 'false',
    maxRetries: Number.parseInt(process.env['OPENSEARCH_BOOTSTRAP_MAX_RETRIES'] ?? '8', 10),
    baseRetryDelayMs: Number.parseInt(process.env['OPENSEARCH_BOOTSTRAP_RETRY_BASE_MS'] ?? '500', 10),
    maxRetryDelayMs: Number.parseInt(process.env['OPENSEARCH_BOOTSTRAP_RETRY_MAX_MS'] ?? '8000', 10),
    bootstrapTimeoutMs: Number.parseInt(process.env['OPENSEARCH_BOOTSTRAP_TIMEOUT_MS'] ?? '120000', 10),
  };
}
