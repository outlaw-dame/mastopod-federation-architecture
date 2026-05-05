/**
 * HTTP client for the ActivityPods provider inbox-events internal endpoint.
 *
 * Forwards non-Flag provider-directed ActivityPub activities (Undo{Flag},
 * Accept, Reject, and generic) to ActivityPods so the operator can act on
 * incoming federation signals without the sidecar having to interpret policy.
 *
 * Error contract:
 *   - true  → event delivered (or permanently unrecoverable 4xx) → caller SHOULD ACK
 *   - false → transient failure (5xx / network) → caller MUST NOT ACK so the
 *             message is retried via XAUTOCLAIM
 */

import { withRetry } from "../mrf/utils.js";
import { logger } from "../../utils/logger.js";

// ─── Input size limits ────────────────────────────────────────────────────────

const MAX_URI_LEN = 2048;
const MAX_ID_LEN = 512;
const MAX_TYPE_LEN = 64;
const MAX_BODY_BYTES = 32 * 1024; // 32 KB

// ─── Options ─────────────────────────────────────────────────────────────────

export interface ProviderInboxEventClientOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function safeSerialize(activity: unknown): string {
  try {
    const raw = JSON.stringify(activity);
    if (typeof raw !== "string") return "{}";
    return raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw;
  } catch {
    return "{}";
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class ActivityPodsProviderInboxEventClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(options: ProviderInboxEventClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.bearerToken = options.bearerToken;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 5_000);
    this.retries = Math.max(0, options.retries ?? 3);
    this.retryBaseMs = Math.max(25, options.retryBaseMs ?? 100);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 2_000);
  }

  /**
   * Notify ActivityPods that an Undo{Flag} was received.
   *
   * Returns true if delivered or permanently unrecoverable (caller ACKs),
   * false if a transient error persisted after all retries (caller does NOT ACK).
   */
  async sendUndoFlag(params: {
    activityId: string;
    actorUri: string;
    originalFlagId: string;
    envelopePath: string;
    receivedAt: string;
    rawActivity: unknown;
  }): Promise<boolean> {
    return this.sendEvent({
      eventType: "UndoFlag",
      activityId: truncate(params.activityId, MAX_ID_LEN),
      actorUri: truncate(params.actorUri, MAX_URI_LEN),
      originalFlagId: truncate(params.originalFlagId, MAX_ID_LEN),
      envelopePath: truncate(params.envelopePath, MAX_URI_LEN),
      receivedAt: params.receivedAt,
      rawActivity: params.rawActivity,
    });
  }

  /**
   * Notify ActivityPods that an Accept or Reject was received at the provider
   * inbox.
   *
   * Returns true if delivered or permanently unrecoverable, false on transient
   * failure.
   */
  async sendAcceptReject(params: {
    activityId: string;
    actorUri: string;
    activityType: "Accept" | "Reject";
    objectId: string | null;
    envelopePath: string;
    receivedAt: string;
    rawActivity: unknown;
  }): Promise<boolean> {
    return this.sendEvent({
      eventType: params.activityType,
      activityId: truncate(params.activityId, MAX_ID_LEN),
      actorUri: truncate(params.actorUri, MAX_URI_LEN),
      objectId: params.objectId != null ? truncate(params.objectId, MAX_ID_LEN) : null,
      envelopePath: truncate(params.envelopePath, MAX_URI_LEN),
      receivedAt: params.receivedAt,
      rawActivity: params.rawActivity,
    });
  }

  /**
   * Forward any other provider-directed AP activity as a generic inbox event.
   *
   * Returns true if delivered or permanently unrecoverable, false on transient
   * failure.
   */
  async sendGenericEvent(params: {
    activityId: string | null;
    actorUri: string;
    activityType: string;
    envelopePath: string;
    receivedAt: string;
    rawActivity: unknown;
  }): Promise<boolean> {
    return this.sendEvent({
      eventType: "Generic",
      activityType: truncate(params.activityType, MAX_TYPE_LEN),
      activityId: params.activityId != null ? truncate(params.activityId, MAX_ID_LEN) : null,
      actorUri: truncate(params.actorUri, MAX_URI_LEN),
      envelopePath: truncate(params.envelopePath, MAX_URI_LEN),
      receivedAt: params.receivedAt,
      rawActivity: params.rawActivity,
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async sendEvent(payload: Record<string, unknown>): Promise<boolean> {
    const serializedActivity = safeSerialize(payload["rawActivity"]);
    const body = JSON.stringify({ ...payload, rawActivity: serializedActivity });

    const execute = async (): Promise<boolean> => {
      const response = await fetch(
        `${this.baseUrl}/api/internal/moderation/inbox-events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.bearerToken}`,
            "content-type": "application/json",
            "cache-control": "no-store",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );

      if (response.status >= 200 && response.status < 300) {
        await response.text().catch(() => undefined);
        return true;
      }

      if (!isRetryableStatus(response.status)) {
        // 4xx (non-408, non-429, non-425) — permanently unrecoverable.
        // Log and return true so the caller ACKs and moves on.
        const snippet = await response.text().then((t) => t.slice(0, 512)).catch(() => "");
        logger.warn("[ProviderInboxEventClient] Non-retryable error from ActivityPods inbox-events", {
          status: response.status,
          snippet,
          eventType: payload["eventType"],
        });
        return true;
      }

      // Retryable: 5xx / 408 / 425 / 429 — throw so withRetry backs off.
      await response.text().catch(() => undefined);
      const err = new Error(`ActivityPods inbox-events returned ${response.status}`) as Error & { retryable: true };
      err.retryable = true;
      throw err;
    };

    try {
      return await withRetry(execute, {
        retries: this.retries,
        baseMs: this.retryBaseMs,
        maxMs: this.retryMaxMs,
        retryIf: (err) =>
          (err as { retryable?: boolean } | null | undefined)?.retryable === true,
      });
    } catch (err: unknown) {
      logger.warn("[ProviderInboxEventClient] Provider inbox event forward failed after retries", {
        error: err instanceof Error ? err.message : String(err),
        eventType: payload["eventType"],
      });
      return false;
    }
  }
}
