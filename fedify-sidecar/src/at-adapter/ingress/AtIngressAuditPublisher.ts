/**
 * V6.5 Phase 5.5: AT Ingress Audit Publisher
 *
 * Publishes structured failure events to the at.verify-failed.v1 topic.
 *
 * This component is the sole write path for verification failures, ensuring
 * that all failures are observable and replayable without polluting the
 * trusted at.ingress.v1 stream.
 *
 * Design principles:
 *   - Publish failures are non-fatal: a failure to publish a failure event
 *     is logged but does not crash the verifier.
 *   - All published events include a failedAt timestamp for temporal ordering.
 *   - The publisher is intentionally narrow: it only writes to the failure
 *     topic and never to the trusted ingress topic.
 *
 * Security notes:
 *   - The details field is sanitised to prevent excessively large payloads.
 *   - Error messages from internal exceptions are not forwarded verbatim to
 *     the event payload to prevent information leakage.
 */

import { AtVerifyFailedEvent } from './AtIngressEvents';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents';

// ---------------------------------------------------------------------------
// Topic constant
// ---------------------------------------------------------------------------

export const AT_VERIFY_FAILED_TOPIC = 'at.verify-failed.v1';

/** Maximum byte size for the details field to prevent oversized payloads. */
const MAX_DETAILS_SIZE_BYTES = 4096;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AtIngressAuditPublisher {
  /**
   * Publish a structured verification failure event.
   * Non-throwing: logs errors internally rather than propagating them.
   */
  publishVerifyFailed(event: AtVerifyFailedEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtIngressAuditPublisher implements AtIngressAuditPublisher {
  constructor(private readonly eventPublisher: EventPublisher) {}

  async publishVerifyFailed(event: AtVerifyFailedEvent): Promise<void> {
    const sanitised = sanitiseFailureEvent(event);

    try {
      await this.eventPublisher.publish(AT_VERIFY_FAILED_TOPIC, sanitised as any);
    } catch (err) {
      // Failure to publish a failure event is non-fatal.
      // Log with structured context for observability.
      console.error('[AtIngressAuditPublisher] Failed to publish verify-failed event', {
        seq: event.seq,
        source: event.source,
        reason: event.reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (for testing)
// ---------------------------------------------------------------------------

export class InMemoryAtIngressAuditPublisher implements AtIngressAuditPublisher {
  public readonly published: AtVerifyFailedEvent[] = [];

  async publishVerifyFailed(event: AtVerifyFailedEvent): Promise<void> {
    this.published.push(sanitiseFailureEvent(event));
  }
}

// ---------------------------------------------------------------------------
// Sanitisation helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise a failure event before publishing.
 * - Ensures failedAt is set.
 * - Truncates the details field to prevent oversized payloads.
 * - Strips any prototype-polluting keys from details.
 */
function sanitiseFailureEvent(event: AtVerifyFailedEvent): AtVerifyFailedEvent {
  const sanitised: AtVerifyFailedEvent = {
    seq: event.seq,
    did: event.did ?? null,
    source: event.source,
    eventType: event.eventType,
    failedAt: event.failedAt || new Date().toISOString(),
    reason: event.reason,
  };

  if (event.details) {
    sanitised.details = sanitiseDetails(event.details);
  }

  return sanitised;
}

/**
 * Sanitise the details object:
 * - Remove prototype-polluting keys (__proto__, constructor, prototype).
 * - Truncate the serialised payload to MAX_DETAILS_SIZE_BYTES.
 */
function sanitiseDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(details)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    safe[key] = value;
  }

  // Truncate if serialised size exceeds limit.
  const serialised = JSON.stringify(safe);
  if (serialised.length > MAX_DETAILS_SIZE_BYTES) {
    return { _truncated: true, _originalSize: serialised.length };
  }

  return safe;
}
