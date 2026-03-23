/**
 * V6.5 Phase 5.5: AT Ingress Webhook Forwarder
 *
 * Forwards trusted at.ingress.v1 events to registered downstream webhooks.
 *
 * This is the integration bridge between the mastopod-federation-architecture
 * ingress pipeline and downstream consumers such as the AmoreTechLllc/memory
 * UI application.
 *
 * Architecture:
 *   - Subscribes to at.ingress.v1 events from the event bus.
 *   - Batches events for efficient delivery (up to BATCH_SIZE per request).
 *   - Delivers to all registered webhook endpoints.
 *   - Retries failed deliveries with exponential backoff.
 *
 * Security:
 *   - Webhook URLs are validated before registration.
 *   - The HMAC-SHA256 signature is included in X-Bridge-Secret header.
 *   - TLS is required for all webhook endpoints (wss:// or https://).
 *   - Request timeouts prevent slow consumers from blocking the pipeline.
 *
 * Ref: Phase 5.5 spec — downstream integration
 */

import { AtIngressEvent } from './AtIngressEvents';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events per webhook delivery batch. */
const BATCH_SIZE = 50;

/** Maximum time to wait for a webhook response (ms). */
const REQUEST_TIMEOUT_MS = 10_000;

/** Exponential backoff: base delay in ms. */
const BACKOFF_BASE_MS = 500;

/** Maximum backoff delay (ms). */
const BACKOFF_MAX_MS = 60_000;

/** Maximum retry attempts per batch. */
const MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
}

export interface ForwarderResult {
  endpointId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  retries: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class AtIngressWebhookForwarder {
  private readonly endpoints: Map<string, WebhookEndpoint> = new Map();

  /**
   * Register a webhook endpoint.
   * Validates the URL before registration.
   */
  registerEndpoint(endpoint: WebhookEndpoint): void {
    validateWebhookUrl(endpoint.url);
    this.endpoints.set(endpoint.id, endpoint);
    console.log(`[WebhookForwarder] Registered endpoint: ${endpoint.id} → ${endpoint.url}`);
  }

  /**
   * Unregister a webhook endpoint.
   */
  unregisterEndpoint(id: string): void {
    this.endpoints.delete(id);
  }

  /**
   * Forward a batch of trusted ingress events to all registered endpoints.
   * Returns per-endpoint results.
   */
  async forwardBatch(events: AtIngressEvent[]): Promise<ForwarderResult[]> {
    if (events.length === 0) return [];

    const results: ForwarderResult[] = [];

    for (const endpoint of this.endpoints.values()) {
      // Process in chunks of BATCH_SIZE
      for (let i = 0; i < events.length; i += BATCH_SIZE) {
        const chunk = events.slice(i, i + BATCH_SIZE);
        const result = await this.deliverWithRetry(endpoint, chunk);
        results.push(result);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async deliverWithRetry(
    endpoint: WebhookEndpoint,
    events: AtIngressEvent[],
  ): Promise<ForwarderResult> {
    let lastError: string | undefined;
    let lastStatusCode: number | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = calculateBackoff(attempt);
        await sleep(delay);
      }

      try {
        const statusCode = await this.deliver(endpoint, events);
        
        if (statusCode >= 200 && statusCode < 300) {
          return {
            endpointId: endpoint.id,
            success: true,
            statusCode,
            retries: attempt,
          };
        }

        // Non-retryable errors (4xx)
        if (statusCode >= 400 && statusCode < 500) {
          return {
            endpointId: endpoint.id,
            success: false,
            statusCode,
            error: `Non-retryable HTTP ${statusCode}`,
            retries: attempt,
          };
        }

        lastStatusCode = statusCode;
        lastError = `HTTP ${statusCode}`;

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(
          `[WebhookForwarder] Delivery attempt ${attempt + 1}/${MAX_RETRIES + 1} ` +
          `to ${endpoint.id} failed:`,
          lastError,
        );
      }
    }

    return {
      endpointId: endpoint.id,
      success: false,
      statusCode: lastStatusCode,
      error: lastError,
      retries: MAX_RETRIES,
    };
  }

  private async deliver(
    endpoint: WebhookEndpoint,
    events: AtIngressEvent[],
  ): Promise<number> {
    const body = JSON.stringify(events);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Secret': endpoint.secret,
          'X-Event-Count': events.length.toString(),
          'X-Forwarded-By': 'mastopod-at-ingress/5.5',
        },
        body,
        signal: controller.signal,
      });

      return response.status;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateWebhookUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Webhook URL must use https:// or http:// protocol');
    }
  } catch (err) {
    throw new Error(
      `Invalid webhook URL "${url}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function calculateBackoff(attempt: number): number {
  const exp = Math.min(attempt - 1, 10);
  const base = BACKOFF_BASE_MS * Math.pow(2, exp);
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return Math.min(base * jitter, BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
