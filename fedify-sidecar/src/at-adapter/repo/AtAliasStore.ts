/**
 * V6.5 Phase 3: ATProto Alias Store
 *
 * Maps canonical IDs to ATProto aliases used for update/delete/reference parity.
 */

import type { ActivityPodsEmojiDefinition } from "../lexicon/ActivityPodsEmojiLexicon.js";

export interface AtAliasRecord {
  canonicalRefId: string;
  canonicalType: 'profile' | 'post' | 'article' | 'follow' | 'like' | 'repost' | 'emojiReaction';
  did: string;
  collection:
    | 'app.bsky.actor.profile'
    | 'app.bsky.feed.post'
    | 'site.standard.document'
    | 'app.bsky.graph.follow'
    | 'app.bsky.feed.like'
    | 'app.bsky.feed.repost'
    | 'org.activitypods.emojiReaction';
  rkey: string;
  atUri: string;
  cid?: string | null;
  lastRev?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  subjectDid?: string | null;
  subjectUri?: string | null;
  subjectCid?: string | null;
  reactionContent?: string | null;
  reactionEmoji?: ActivityPodsEmojiDefinition | null;
  canonicalUrl?: string | null;
  activityPubObjectId?: string | null;
}

export interface AtAliasStore {
  getByCanonicalRefId(canonicalRefId: string): Promise<AtAliasRecord | null>;
  put(alias: AtAliasRecord): Promise<void>;
  markDeleted(canonicalRefId: string, deletedAt: string): Promise<void>;
  updateCidAndRev(canonicalRefId: string, cid: string, rev: string): Promise<void>;
  listByDid(did: string): Promise<AtAliasRecord[]>;
  listActive(): Promise<AtAliasRecord[]>;
}

export class InMemoryAtAliasStore implements AtAliasStore {
  private aliases = new Map<string, AtAliasRecord>();

  async getByCanonicalRefId(canonicalRefId: string): Promise<AtAliasRecord | null> {
    return this.aliases.get(canonicalRefId) || null;
  }

  async put(alias: AtAliasRecord): Promise<void> {
    this.aliases.set(alias.canonicalRefId, alias);
  }

  async markDeleted(canonicalRefId: string, deletedAt: string): Promise<void> {
    const alias = this.aliases.get(canonicalRefId);
    if (alias) {
      alias.deletedAt = deletedAt;
      alias.updatedAt = deletedAt;
    }
  }

  async updateCidAndRev(canonicalRefId: string, cid: string, rev: string): Promise<void> {
    const alias = this.aliases.get(canonicalRefId);
    if (alias) {
      alias.cid = cid;
      alias.lastRev = rev;
      alias.updatedAt = new Date().toISOString();
    }
  }

  async listByDid(did: string): Promise<AtAliasRecord[]> {
    return Array.from(this.aliases.values()).filter(a => a.did === did);
  }

  async listActive(): Promise<AtAliasRecord[]> {
    return Array.from(this.aliases.values()).filter(a => !a.deletedAt);
  }
}

const ALIAS_SCAN_COUNT = 100;

/**
 * Redis-backed AT Alias Store.
 *
 * Enumeration deliberately uses cursor-based SCAN plus one MGET per bounded
 * page. Redis KEYS is never used here because it is O(total keyspace) and
 * blocks the Redis event loop while walking the database. This store shares
 * Redis with latency-sensitive sidecar state, so a large alias population must
 * not stall unrelated queue/session/cache traffic.
 *
 * The scan remains compatible with all legacy canonical alias keys. Secondary
 * DID/active indexes can be introduced later only with an explicit migration
 * contract; this change improves safety without making existing aliases
 * invisible.
 */
export class RedisAtAliasStore implements AtAliasStore {
  private readonly redis: any;
  private readonly prefix = 'at:alias:';

  constructor(redis: any) {
    this.redis = redis;
  }

  async getByCanonicalRefId(canonicalRefId: string): Promise<AtAliasRecord | null> {
    const key = `${this.prefix}canonical:${canonicalRefId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async put(alias: AtAliasRecord): Promise<void> {
    const key = `${this.prefix}canonical:${alias.canonicalRefId}`;
    await this.redis.set(key, JSON.stringify(alias));
  }

  async markDeleted(canonicalRefId: string, deletedAt: string): Promise<void> {
    const alias = await this.getByCanonicalRefId(canonicalRefId);
    if (alias) {
      alias.deletedAt = deletedAt;
      alias.updatedAt = deletedAt;
      await this.put(alias);
    }
  }

  async updateCidAndRev(canonicalRefId: string, cid: string, rev: string): Promise<void> {
    const alias = await this.getByCanonicalRefId(canonicalRefId);
    if (alias) {
      alias.cid = cid;
      alias.lastRev = rev;
      alias.updatedAt = new Date().toISOString();
      await this.put(alias);
    }
  }

  async listByDid(did: string): Promise<AtAliasRecord[]> {
    const aliases: AtAliasRecord[] = [];
    for await (const alias of this.scanAliases()) {
      if (alias.did === did) aliases.push(alias);
    }
    return aliases;
  }

  async listActive(): Promise<AtAliasRecord[]> {
    const aliases: AtAliasRecord[] = [];
    for await (const alias of this.scanAliases()) {
      if (!alias.deletedAt) aliases.push(alias);
    }
    return aliases;
  }

  private async *scanAliases(): AsyncIterable<AtAliasRecord> {
    let cursor = '0';
    const pattern = `${this.prefix}canonical:*`;

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        ALIAS_SCAN_COUNT
      );
      cursor = nextCursor;

      if (!Array.isArray(keys) || keys.length === 0) continue;

      const values = await this.redis.mget(...keys);
      for (const raw of values) {
        // A key may expire or be deleted between SCAN and MGET.
        if (raw == null) continue;
        yield JSON.parse(raw) as AtAliasRecord;
      }
    } while (cursor !== '0');
  }
}
