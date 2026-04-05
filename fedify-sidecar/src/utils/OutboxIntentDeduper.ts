import { logger } from "./logger.js";

export interface OutboxIntentDeduperStore {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
}

export interface OutboxIntentDeduperConfig {
  prefix: string;
  ttlSeconds: number;
  store?: OutboxIntentDeduperStore | null;
  now?: () => number;
}

/**
 * Best-effort dedupe for at-least-once consumers of local outbox-derived events.
 *
 * Redis-backed mode uses SET NX EX for cross-process dedupe.
 * In-memory mode is the fallback for isolated tests or single-process consumers.
 */
export class OutboxIntentDeduper {
  private readonly prefix: string;
  private readonly ttlMs: number;
  private readonly store: OutboxIntentDeduperStore | null;
  private readonly now: () => number;
  private readonly memory = new Map<string, number>();

  constructor(config: OutboxIntentDeduperConfig) {
    this.prefix = config.prefix;
    this.ttlMs = Math.max(1, config.ttlSeconds) * 1000;
    this.store = config.store ?? null;
    this.now = config.now ?? (() => Date.now());
  }

  async claim(intentId: string): Promise<boolean> {
    const normalized = intentId.trim();
    if (!normalized) {
      return true;
    }

    if (this.store) {
      try {
        const result = await this.store.set(
          `${this.prefix}:${normalized}`,
          "1",
          "EX",
          Math.ceil(this.ttlMs / 1000),
          "NX",
        );
        return result === "OK";
      } catch (error) {
        logger.warn("Outbox intent dedupe store unavailable, falling back to memory", {
          prefix: this.prefix,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.prune();
    const now = this.now();
    const existing = this.memory.get(normalized);
    if (existing && existing > now) {
      return false;
    }

    this.memory.set(normalized, now + this.ttlMs);
    return true;
  }

  private prune(): void {
    if (this.memory.size === 0) {
      return;
    }

    const now = this.now();
    for (const [intentId, expiresAt] of this.memory) {
      if (expiresAt <= now) {
        this.memory.delete(intentId);
      }
    }
  }
}

export function extractOutboxIntentId(
  event: unknown,
  headers?: Record<string, Buffer | string | undefined> | undefined,
): string | undefined {
  const headerValue = headers?.["outbox-intent-id"];
  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue.trim();
  }
  if (headerValue instanceof Buffer) {
    const decoded = headerValue.toString("utf8").trim();
    if (decoded.length > 0) {
      return decoded;
    }
  }

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }

  const candidate = event as Record<string, unknown>;
  return typeof candidate["outboxIntentId"] === "string" && candidate["outboxIntentId"].trim().length > 0
    ? candidate["outboxIntentId"].trim()
    : undefined;
}
