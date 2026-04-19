/**
 * OpenSearchHealthGate
 *
 * A lightweight readiness gate that the SearchIndexerService checks before
 * attempting to write.  It caches the last health result for a configurable
 * TTL so we never hammer the cluster with redundant health checks.
 *
 * This is intentionally separate from the bootstrap service — the bootstrap
 * runs once at startup, whereas this gate runs continuously at runtime.
 */

import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import { logger } from '../../utils/logger.js';

export interface OpenSearchHealthGateConfig {
  /** How often (ms) to re-probe if the last check was healthy */
  healthyPollIntervalMs: number;
  /** How often (ms) to re-probe if the last check was unhealthy */
  unhealthyPollIntervalMs: number;
  /** Request timeout for the health probe itself */
  probeTimeoutMs: number;
}

const DEFAULT_CONFIG: OpenSearchHealthGateConfig = {
  healthyPollIntervalMs: 30_000,
  unhealthyPollIntervalMs: 5_000,
  probeTimeoutMs: 5_000,
};

export class OpenSearchHealthGate {
  private lastCheckMs = 0;
  private lastHealthy = false;
  private readonly config: OpenSearchHealthGateConfig;

  constructor(
    private readonly client: OpenSearchNativeClient,
    config?: Partial<OpenSearchHealthGateConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Returns `true` if the cluster is reachable and yellow/green.
   * Uses a cached result within the configured poll interval.
   */
  async isHealthy(): Promise<boolean> {
    const now = Date.now();
    const interval = this.lastHealthy
      ? this.config.healthyPollIntervalMs
      : this.config.unhealthyPollIntervalMs;

    if (now - this.lastCheckMs < interval) {
      return this.lastHealthy;
    }

    try {
      const resp = await this.client.cluster.health({
        timeout: `${this.config.probeTimeoutMs}ms`,
      });

      const status = resp.body?.['status'];
      this.lastHealthy = status === 'yellow' || status === 'green';
    } catch {
      this.lastHealthy = false;
    }

    this.lastCheckMs = Date.now();

    if (!this.lastHealthy) {
      logger.warn('[OpenSearchHealthGate] Cluster unhealthy or unreachable');
    }

    return this.lastHealthy;
  }

  /**
   * Force the gate into an unknown state so the next `isHealthy()` call
   * will perform a fresh probe.
   */
  invalidate(): void {
    this.lastCheckMs = 0;
  }
}
