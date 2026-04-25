/**
 * FedifyKvAdapter
 *
 * Implements the Fedify 2.x KvStore interface backed by ioredis.
 *
 * Fedify 2.x made KvStore.list() a required method (it was optional in 1.x).
 * This adapter satisfies that contract in full.
 *
 * Key encoding: KvKey (string[]) is joined with ":" and namespaced under
 * the configured prefix so Fedify keys never collide with sidecar keys.
 *
 * TTL: Fedify passes Temporal.Duration objects. We convert to seconds via
 * the standard Temporal API (available in Node >= 22 natively; polyfilled
 * in Node 20 via --experimental-vm-modules or the temporal-polyfill package).
 * If Temporal is not available at runtime we fall back to no-TTL behaviour
 * with a warning, which is safe for correctness but not for cache eviction.
 */

import type { Redis } from "ioredis";
import type {
  KvKey,
  KvStore,
  KvStoreListEntry,
  KvStoreSetOptions,
} from "@fedify/fedify";

// ---------------------------------------------------------------------------
// Fedify 2.x KvStore interface
// Imported from the installed package so the adapter stays aligned with the
// exact runtime contract.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

const DEFAULT_NAMESPACE = "fedify:kv";
const SCAN_COUNT = 100;

export class FedifyKvAdapter implements KvStore {
  private readonly namespace: string;

  constructor(
    private readonly redis: Redis,
    namespace = DEFAULT_NAMESPACE
  ) {
    this.namespace = namespace;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private encodeKey(key: KvKey): string {
    return `${this.namespace}:${key.map(encodeURIComponent).join(":")}`;
  }

  private decodeKey(raw: string): KvKey {
    const withoutNs = raw.slice(this.namespace.length + 1);
    const parts = withoutNs.split(":").map(decodeURIComponent);
    return (parts.length > 0 ? parts : [""]) as unknown as KvKey;
  }

  private ttlSeconds(ttl: unknown): number | null {
    if (ttl == null) return null;
    // Temporal.Duration (TC39 stage 3 — available in Node 22+)
    if (
      typeof ttl === "object" &&
      ttl !== null &&
      "total" in ttl &&
      typeof (ttl as { total: unknown }).total === "function"
    ) {
      const secs = Math.ceil(
        (ttl as { total(unit: string): number }).total("seconds")
      );
      return secs > 0 ? secs : null;
    }
    // Fallback: numeric seconds
    if (typeof ttl === "number" && ttl > 0) return Math.ceil(ttl);
    return null;
  }

  // --------------------------------------------------------------------------
  // KvStore interface
  // --------------------------------------------------------------------------

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    const raw = await this.redis.get(this.encodeKey(key));
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }

  async set(key: KvKey, value: unknown, options?: KvStoreSetOptions): Promise<void> {
    const encoded = this.encodeKey(key);
    const serialized = JSON.stringify(value);
    const ttl = options?.ttl != null ? this.ttlSeconds(options.ttl) : null;
    if (ttl != null) {
      await this.redis.setex(encoded, ttl, serialized);
    } else {
      await this.redis.set(encoded, serialized);
    }
  }

  async delete(key: KvKey): Promise<void> {
    await this.redis.del(this.encodeKey(key));
  }

  // list() is required in Fedify 2.x (was optional in 1.x).
  // Uses Redis SCAN to page through keys matching the given prefix.
  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    const prefixKey = this.encodeKey(prefix ?? [""]);
    const pattern = `${prefixKey}*`;
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT
      );
      cursor = nextCursor;

      for (const rawKey of keys) {
        const raw = await this.redis.get(rawKey);
        if (raw == null) continue;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
        yield { key: this.decodeKey(rawKey), value };
      }
    } while (cursor !== "0");
  }
}
