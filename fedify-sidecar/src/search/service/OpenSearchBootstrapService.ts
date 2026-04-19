/**
 * OpenSearchBootstrapService
 *
 * Idempotent bootstrap that runs on every sidecar startup:
 *   1. Wait for OpenSearch cluster health (yellow+) with exponential backoff.
 *   2. Create or verify the hybrid search pipeline (normalization-processor).
 *   3. Create or verify the public-content-v1 index with the canonical mapping.
 *   4. Create or verify the public-author-v1 index.
 *
 * All operations are fully idempotent — safe to call on every cold start.
 *
 * Security:
 *   - No sensitive data is logged (passwords, tokens).
 *   - SSL verification defaults to on; callers must explicitly disable.
 *   - Timeout caps prevent indefinite hangs.
 */

import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import { PublicContentMapping } from '../mappings/PublicContentMapping.js';
import { PublicAuthorMapping } from '../mappings/PublicAuthorMapping.js';
import { HybridQueryBuilder } from '../queries/HybridQueryBuilder.js';
import { logger } from '../../utils/logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface OpenSearchBootstrapConfig {
  /** OpenSearch node URL (e.g. http://localhost:9200) */
  opensearchUrl: string;
  /** Optional basic-auth username */
  opensearchUsername?: string;
  /** Optional basic-auth password */
  opensearchPassword?: string;
  /** Reject self-signed TLS certs (default: true) */
  opensearchSslVerify: boolean;

  /** Maximum number of connection retry attempts before giving up */
  maxRetries: number;
  /** Base delay for exponential backoff in milliseconds */
  baseRetryDelayMs: number;
  /** Maximum delay cap for exponential backoff in milliseconds */
  maxRetryDelayMs: number;
  /** Overall deadline — abort bootstrap if not done within this window */
  bootstrapTimeoutMs: number;
}

// ─── Index / Pipeline Names ─────────────────────────────────────────────────

const CONTENT_INDEX = 'public-content-v1';
const AUTHOR_INDEX = 'public-author-v1';
const HYBRID_PIPELINE = 'public-hybrid-pipeline-v1';
const INGEST_PIPELINE = 'public-content-ingest-v1';

// ─── Service ────────────────────────────────────────────────────────────────

export class OpenSearchBootstrapService {
  private readonly client: OpenSearchNativeClient;
  private readonly config: OpenSearchBootstrapConfig;
  private readonly queryBuilder = new HybridQueryBuilder();

  constructor(config: OpenSearchBootstrapConfig) {
    this.config = config;

    const clientOpts: Record<string, unknown> = {
      node: config.opensearchUrl,
      ssl: { rejectUnauthorized: config.opensearchSslVerify },
      requestTimeout: 30_000,
      maxRetries: 0, // We handle retries ourselves
    };

    if (config.opensearchUsername) {
      clientOpts['auth'] = {
        username: config.opensearchUsername,
        password: config.opensearchPassword ?? '',
      };
    }

    this.client = new OpenSearchNativeClient(clientOpts);
  }

  /**
   * Run the full bootstrap sequence.
   * Throws if the cluster cannot be reached within the configured deadline.
   */
  async bootstrap(): Promise<void> {
    const deadline = Date.now() + this.config.bootstrapTimeoutMs;

    logger.info('[OpenSearchBootstrap] Starting bootstrap', {
      url: this.config.opensearchUrl,
      maxRetries: this.config.maxRetries,
      bootstrapTimeoutMs: this.config.bootstrapTimeoutMs,
    });

    // Step 1: Wait for cluster health
    await this.waitForCluster(deadline);

    // Step 2: Ensure ingest pipeline exists (must exist before index creation
    // because the content mapping references it as default_pipeline)
    await this.ensureIngestPipeline(deadline);

    // Step 3: Ensure hybrid search pipeline exists
    await this.ensureHybridSearchPipeline(deadline);

    // Step 4: Ensure public-content-v1 index
    await this.ensureIndex(CONTENT_INDEX, PublicContentMapping, deadline);

    // Step 5: Ensure public-author-v1 index
    await this.ensureIndex(AUTHOR_INDEX, PublicAuthorMapping, deadline);

    logger.info('[OpenSearchBootstrap] Bootstrap complete');
  }

  /**
   * Close the underlying HTTP client.
   */
  async close(): Promise<void> {
    await this.client.close();
  }

  // ─── Step 1: Cluster Health ─────────────────────────────────────────────

  private async waitForCluster(deadline: number): Promise<void> {
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      this.assertDeadline(deadline, 'waitForCluster');

      try {
        const resp = await this.client.cluster.health({
          wait_for_status: 'yellow',
          timeout: '10s',
        });

        const status = resp.body?.['status'];
        if (status === 'yellow' || status === 'green') {
          logger.info('[OpenSearchBootstrap] Cluster healthy', { status });
          return;
        }

        logger.warn('[OpenSearchBootstrap] Cluster status not ready', { status });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[OpenSearchBootstrap] Cluster health check failed', {
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries,
          error: msg,
        });
      }

      attempt++;
      await this.backoff(attempt, deadline);
    }

    throw new Error(
      `[OpenSearchBootstrap] Cluster not reachable after ${this.config.maxRetries} attempts`,
    );
  }

  // ─── Step 2: Ingest Pipeline ────────────────────────────────────────────

  /**
   * The ingest pipeline is referenced by PublicContentMapping as the
   * default_pipeline.  For Phase 1 it is a no-op passthrough — embedding
   * enrichment will be added in Phase 2 when a real embedding model is wired.
   */
  private async ensureIngestPipeline(deadline: number): Promise<void> {
    await this.retryableOperation('ensureIngestPipeline', deadline, async () => {
      try {
        await this.client.ingest.getPipeline({ id: INGEST_PIPELINE });
        logger.info('[OpenSearchBootstrap] Ingest pipeline already exists', {
          pipeline: INGEST_PIPELINE,
        });
        return;
      } catch (err: unknown) {
        // 404 means "doesn't exist yet" — create it
        if (!this.isNotFoundError(err)) throw err;
      }

      await this.client.ingest.putPipeline({
        id: INGEST_PIPELINE,
        body: {
          description: 'Public content ingest pipeline — Phase 1 passthrough',
          processors: [
            {
              set: {
                field: 'embeddingStatus',
                value: 'pending',
                override: false,
              },
            },
          ],
        },
      });

      logger.info('[OpenSearchBootstrap] Ingest pipeline created', {
        pipeline: INGEST_PIPELINE,
      });
    });
  }

  // ─── Step 3: Hybrid Search Pipeline ─────────────────────────────────────

  private async ensureHybridSearchPipeline(deadline: number): Promise<void> {
    await this.retryableOperation('ensureHybridSearchPipeline', deadline, async () => {
      try {
        const resp = await this.client.transport.request({
          method: 'GET',
          path: `/_search/pipeline/${HYBRID_PIPELINE}`,
        });
        if (resp.statusCode === 200) {
          logger.info('[OpenSearchBootstrap] Hybrid search pipeline already exists', {
            pipeline: HYBRID_PIPELINE,
          });
          return;
        }
      } catch (err: unknown) {
        if (!this.isNotFoundError(err)) throw err;
      }

      const pipelineConfig = this.queryBuilder.getHybridPipelineConfig();

      await this.client.transport.request({
        method: 'PUT',
        path: `/_search/pipeline/${HYBRID_PIPELINE}`,
        body: pipelineConfig,
      });

      logger.info('[OpenSearchBootstrap] Hybrid search pipeline created', {
        pipeline: HYBRID_PIPELINE,
      });
    });
  }

  // ─── Step 4 / 5: Index Creation ─────────────────────────────────────────

  private async ensureIndex(
    indexName: string,
    mapping: { settings: Record<string, unknown>; mappings: Record<string, unknown> },
    deadline: number,
  ): Promise<void> {
    await this.retryableOperation(`ensureIndex(${indexName})`, deadline, async () => {
      const exists = await this.client.indices.exists({ index: indexName });

      if (exists.body === true) {
        logger.info('[OpenSearchBootstrap] Index already exists', { index: indexName });
        // Optionally update mappings (additive only — never remove fields)
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
   * Attempt to put the latest mappings.  This is additive — OpenSearch will
   * reject mappings that try to change an existing field type, which is the
   * safe behavior we want.  Any rejection is logged as a warning, not an error.
   */
  private async safeUpdateMappings(
    indexName: string,
    mappings: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Extract just the properties for a PUT mapping call
      const properties = (mappings as any)?.properties;
      if (!properties) return;

      await this.client.indices.putMapping({
        index: indexName,
        body: { properties },
      });

      logger.debug('[OpenSearchBootstrap] Mappings updated (additive)', { index: indexName });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[OpenSearchBootstrap] Could not update mappings (likely field type conflict)', {
        index: indexName,
        error: msg,
      });
    }
  }

  // ─── Retry / Backoff Helpers ──────────────────────────────────────────

  /**
   * Wrap an operation with exponential backoff + jitter and a deadline guard.
   */
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
      } catch (err: unknown) {
        attempt++;
        const msg = err instanceof Error ? err.message : String(err);

        if (attempt >= this.config.maxRetries) {
          logger.error(`[OpenSearchBootstrap] ${operationName} failed after max retries`, {
            attempts: attempt,
            error: msg,
          });
          throw err;
        }

        logger.warn(`[OpenSearchBootstrap] ${operationName} attempt ${attempt} failed, retrying`, {
          error: msg,
        });

        await this.backoff(attempt, deadline);
      }
    }
  }

  /**
   * Exponential backoff with full jitter (AWS recommended pattern).
   * delay = min(maxRetryDelay, baseDelay * 2^attempt) * random(0, 1)
   */
  private async backoff(attempt: number, deadline: number): Promise<void> {
    const exponentialDelay = this.config.baseRetryDelayMs * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxRetryDelayMs);
    const jitteredDelay = Math.floor(cappedDelay * Math.random());

    // Never wait past the deadline
    const remainingMs = deadline - Date.now();
    const finalDelay = Math.max(0, Math.min(jitteredDelay, remainingMs - 500));

    if (finalDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, finalDelay));
    }
  }

  private assertDeadline(deadline: number, context: string): void {
    if (Date.now() >= deadline) {
      throw new Error(`[OpenSearchBootstrap] Deadline exceeded during ${context}`);
    }
  }

  private isNotFoundError(err: unknown): boolean {
    if (err && typeof err === 'object') {
      const statusCode = (err as any).meta?.statusCode ?? (err as any).statusCode;
      return statusCode === 404;
    }
    return false;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createOpenSearchBootstrapConfig(
  overrides?: Partial<OpenSearchBootstrapConfig>,
): OpenSearchBootstrapConfig {
  return {
    opensearchUrl: process.env['OPENSEARCH_URL'] ?? 'http://localhost:9200',
    opensearchUsername: process.env['OPENSEARCH_USERNAME'],
    opensearchPassword: process.env['OPENSEARCH_PASSWORD'],
    opensearchSslVerify: process.env['OPENSEARCH_SSL_VERIFY'] !== 'false',
    maxRetries: parseInt(process.env['OPENSEARCH_BOOTSTRAP_MAX_RETRIES'] ?? '12', 10),
    baseRetryDelayMs: parseInt(process.env['OPENSEARCH_BOOTSTRAP_BASE_DELAY_MS'] ?? '1000', 10),
    maxRetryDelayMs: parseInt(process.env['OPENSEARCH_BOOTSTRAP_MAX_DELAY_MS'] ?? '30000', 10),
    bootstrapTimeoutMs: parseInt(
      process.env['OPENSEARCH_BOOTSTRAP_TIMEOUT_MS'] ?? '120000',
      10,
    ),
    ...overrides,
  };
}
