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

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AtIngressEvent } from './AtIngressEvents.js';

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
    validateWebhookUrl(endpoint.url); // throws on invalid URL, wrong protocol, or literal private host
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
    // DNS rebinding guard: re-resolve on every delivery attempt so that a
    // previously-safe hostname cannot be quietly re-pointed to an internal IP.
    const parsed = validateWebhookUrl(endpoint.url);
    await assertSafeWebhookTarget(parsed);

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

function validateWebhookUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(
      `Invalid webhook URL "${url}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Webhook URL must use https:// or http:// protocol');
  }
  // Reject literal private/loopback hostnames at registration time (sync fast path)
  const host = parsed.hostname;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^::1$/.test(host) ||
    /^fe80:/i.test(host)
  ) {
    throw new Error(`Webhook URL hostname "${host}" resolves to a private/loopback address`);
  }
  return parsed;
}

/**
 * Returns true if the IP string (v4 or v6) is in a private, loopback,
 * link-local, CGNAT, or benchmarking range — addresses that should never
 * be reachable from the public internet.
 */
function isPrivateIp(ip: string): boolean {
  // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped?.[1]) return isPrivateIp(v4mapped[1]);

  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||    // link-local / IMDS
      (a === 100 && b >= 64 && b <= 127) || // CGNAT RFC 6598
      (a === 198 && (b === 18 || b === 19)) || // benchmarking RFC 2544
      a === 0
    );
  }

  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    return (
      low === '::1' ||
      low.startsWith('fc') ||
      low.startsWith('fd') ||
      low.startsWith('fe80:')
    );
  }

  return false;
}

/**
 * Resolves the hostname of a parsed webhook URL and asserts none of the
 * returned IPs are private/internal (DNS rebinding guard).
 */
async function assertSafeWebhookTarget(parsed: URL): Promise<void> {
  const host = parsed.hostname;

  // If the hostname is already a literal IP, check it directly
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`Webhook target IP "${host}" is a private address`);
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch (err) {
    throw new Error(
      `Webhook hostname "${host}" could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (addresses.length === 0) {
    throw new Error(`Webhook hostname "${host}" resolved to no addresses`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `Webhook hostname "${host}" resolved to private address "${address}"`,
      );
    }
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
