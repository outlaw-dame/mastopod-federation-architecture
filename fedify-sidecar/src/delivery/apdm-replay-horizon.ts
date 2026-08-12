export const APDM_AUTOMATIC_PRODUCER_REPLAY_MAX_MS = 48 * 60 * 60 * 1000;
export const APDM_PRODUCER_PROCESSING_ALLOWANCE_MS = 24 * 60 * 60 * 1000;
export const APDM_OUTBOX_INTENT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS = 48 * 60 * 60 * 1000;
export const APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const APDM_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const APDM_MAX_AUTOMATIC_DUPLICATE_AGE_MS =
  APDM_AUTOMATIC_PRODUCER_REPLAY_MAX_MS +
  APDM_PRODUCER_PROCESSING_ALLOWANCE_MS +
  APDM_OUTBOX_INTENT_MAX_AGE_MS +
  APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS;

export const APDM_REPLAY_SAFETY_MARGIN_MS =
  APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS - APDM_MAX_AUTOMATIC_DUPLICATE_AGE_MS;

if (APDM_REPLAY_SAFETY_MARGIN_MS <= 0) {
  throw new Error('APDM replay horizons must remain below completed-delivery retention');
}

export function outboxIntentAgeMs(createdAt: number, nowMs: number = Date.now()): number | null {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  const age = nowMs - createdAt;
  if (!Number.isFinite(age) || age < -APDM_MAX_CLOCK_SKEW_MS) return null;
  return Math.max(0, age);
}

export function redisStreamMessageTimestampMs(messageId: string): number | null {
  if (typeof messageId !== 'string') return null;
  const separator = messageId.indexOf('-');
  if (separator <= 0) return null;
  const timestampText = messageId.slice(0, separator);
  if (!/^\d+$/.test(timestampText)) return null;
  const timestamp = Number(timestampText);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

/**
 * Returns the queue residence in milliseconds. Invalid, non-Redis, or
 * implausibly future Stream IDs return positive infinity so the caller's
 * `> APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS` guard fails closed into the DLQ
 * before any duplicate claim or external delivery can occur.
 */
export function outboundMessageResidenceMs(messageId: string, nowMs: number = Date.now()): number {
  const enqueuedAt = redisStreamMessageTimestampMs(messageId);
  if (enqueuedAt === null) return Number.POSITIVE_INFINITY;
  const age = nowMs - enqueuedAt;
  if (!Number.isFinite(age) || age < -APDM_MAX_CLOCK_SKEW_MS) return Number.POSITIVE_INFINITY;
  return Math.max(0, age);
}
