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
 *   - Legacy X-Bridge-Secret is a raw shared secret, NOT an HMAC signature.
 *     Replacing it requires coordinated downstream signature verification.
 *   - HTTPS is required except explicit loopback-only development.
 *   - Request timeouts prevent slow consumers from blocking the pipeline.
 *
 * Ref: Phase 5.5 spec — downstream integration
 */

import type { AtIngressEvent } from './AtIngressEvents.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events per webhook delivery batch. */
const BATCH_SIZE = 50;

/** Independent endpoints are processed concurrently, never more than four. */
const MAX_ENDPOINT_CONCURRENCY = 4;

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
    // Never log webhook URL paths or queries: these may contain credentials.
    console.log(`[WebhookForwarder] Registered endpoint: ${endpoint.id}`);
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

    const endpoints = [...this.endpoints.values()];
    if (endpoints.length === 0) return [];

    // Distinct endpoints must not block each other. Keep chunks serialized
    // *within* each endpoint, preserve deterministic result order, and bound
    // live HTTP requests/serialized bodies regardless of endpoint count.
    const orderedResults: ForwarderResult[][] = new Array(endpoints.length);
    let nextEndpoint = 0;
    const worker = async (): Promise<void> => {
      while (nextEndpoint < endpoints.length) {
        const index = nextEndpoint++;
        const endpoint = endpoints[index]!;
        const endpointResults: ForwarderResult[] = [];
        for (let offset = 0; offset < events.length; offset += BATCH_SIZE) {
          const chunk = events.slice(offset, offset + BATCH_SIZE);
          // Serialize once per chunk/endpoint, not once per retry. Retain only
          // the active chunk rather than all serialized batches in memory.
          const body = JSON.stringify(chunk);
          endpointResults.push(await this.deliverWithRetry(endpoint, body, chunk.length));
        }
        orderedResults[index] = endpointResults;
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(MAX_ENDPOINT_CONCURRENCY, endpoints.length) },
      () => worker(),
    ));
    return orderedResults.flat();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async deliverWithRetry(
    endpoint: WebhookEndpoint,
    body: string,
    eventCount: number,
  ): Promise<ForwarderResult> {
    let lastError: string | undefined;
    let lastStatusCode: number | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = calculateBackoff(attempt);
        await sleep(delay);
      }

      try {
        const statusCode = await this.deliver(endpoint, body, eventCount);
        
        if (statusCode >= 200 && statusCode < 300) {
          return {
            endpointId: endpoint.id,
            success: true,
            statusCode,
            retries: attempt,
          };
        }

        // HTTP 429 is transient backpressure; the retry budget is bounded.
        // Other 4xx responses are permanent and should not amplify load.
        if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
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
        // Avoid exposing endpoint URL query strings or response contents
        // embedded in lower-level errors. Emit a bounded error category only.
        lastError = err instanceof Error ? err.name : "UnknownTransportError";
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
    body: string,
    eventCount: number,
  ): Promise<number> {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'error', // Never forward credentials to a redirect target.
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': endpoint.secret, // legacy downstream contract
        'X-Event-Count': eventCount.toString(),
        'X-Forwarded-By': 'mastopod-at-ingress/5.5',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // The response body is not part of this legacy contract. Explicitly
    // cancel it so an untrusted endpoint cannot hold a connection open by
    // streaming an unbounded response while keeping its content out of RAM.
    await response.body?.cancel();
    return response.status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateWebhookUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const loopback = process.env["NODE_ENV"] !== 'production' &&
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((!loopback && parsed.protocol !== 'https:') ||
        parsed.username || parsed.password || parsed.hash ||
        parsed.href !== url) {
      throw new Error('Webhook URL must be canonical HTTPS (HTTP allowed for local tests only)');
    }
  } catch (err) {
    // Never echo the supplied URL or an exception containing credentials.
    // Give callers a stable, actionable reason regardless of parse failure.
    throw new Error(
      "Invalid webhook URL: expected canonical HTTPS (loopback HTTP allowed in tests)",
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
