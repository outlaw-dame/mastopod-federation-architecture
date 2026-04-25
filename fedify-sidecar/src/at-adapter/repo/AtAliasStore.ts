/**
 * V6.5 Phase 3: ATProto Alias Store
 *
 * Maps canonical IDs to ATProto aliases.
 * Essential for:
 * - Reusing rkey on updates
 * - Targeting correct URI on deletes
 * - Resolving references for replies/quotes
 */

import type { ActivityPodsEmojiDefinition } from "../lexicon/ActivityPodsEmojiLexicon.js";

/**
 * AT Alias Record
 *
 * Tracks the mapping between canonical entities and their AT repo representations.
 */
export interface AtAliasRecord {
  /**
   * Canonical ID (from Tier 1)
   */
  canonicalRefId: string;
  
  /**
   * Type of canonical entity
   */
  canonicalType: 'profile' | 'post' | 'article' | 'follow' | 'like' | 'repost' | 'emojiReaction';
  
  
  /**
   * Repository DID
   */
  did: string;
  
  /**
   * Collection NSID
   */
  collection:
    | 'app.bsky.actor.profile'
    | 'app.bsky.feed.post'
    | 'site.standard.document'
    | 'app.bsky.graph.follow'
    | 'app.bsky.feed.like'
    | 'app.bsky.feed.repost'
    | 'org.activitypods.emojiReaction';
  
  /**
   * Record key
   */
  rkey: string;
  
  /**
   * AT URI (at://did/collection/rkey)
   */
  atUri: string;
  
  /**
   * Content ID (CBOR hash) of the record
   */
  cid?: string | null;
  
  /**
   * Repository revision at time of last commit
   */
  lastRev?: string | null;
  
  /**
   * Creation timestamp
   */
  createdAt: string;
  
  /**
   * Last update timestamp
   */
  updatedAt: string;
  
  /**
   * Deletion timestamp (if deleted)
   */
  deletedAt?: string | null;

  /**
   * Subject DID (for follows)
   */
  subjectDid?: string | null;

  /**
   * Subject URI (for likes/reposts)
   */
  subjectUri?: string | null;

  /**
   * Subject CID (for likes/reposts)
   */
  subjectCid?: string | null;

  /**
   * Emoji reaction content for custom reaction delete parity.
   */
  reactionContent?: string | null;

  /**
   * Emoji metadata for custom reaction delete parity.
   */
  reactionEmoji?: ActivityPodsEmojiDefinition | null;

  /**
   * Canonical public URL for AP/article projection parity
   */
  canonicalUrl?: string | null;

  /**
   * Stable ActivityPub object identifier when known
   */
  activityPubObjectId?: string | null;
}

/**
 * AT Alias Store Interface
 *
 * Persists canonical-to-AT mappings.
 */
export interface AtAliasStore {
  /**
   * Get alias by canonical reference ID
   */
  getByCanonicalRefId(canonicalRefId: string): Promise<AtAliasRecord | null>;
  
  /**
   * Store or update alias
   */
  put(alias: AtAliasRecord): Promise<void>;
  
  /**
   * Mark alias as deleted
   */
  markDeleted(canonicalRefId: string, deletedAt: string): Promise<void>;
  
  /**
   * Update CID and revision after commit
   */
  updateCidAndRev(canonicalRefId: string, cid: string, rev: string): Promise<void>;
  
  /**
   * List all aliases for a DID
   */
  listByDid(did: string): Promise<AtAliasRecord[]>;
  
  /**
   * Get all active (non-deleted) aliases
   */
  listActive(): Promise<AtAliasRecord[]>;
}

/**
 * In-Memory AT Alias Store (for testing)
 */
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

/**
 * Redis-backed AT Alias Store
 */
export class RedisAtAliasStore implements AtAliasStore {
  private readonly redis: any; // Redis client
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
    // Scan for all keys matching pattern
    const keys = await this.redis.keys(`${this.prefix}canonical:*`);
    const aliases: AtAliasRecord[] = [];
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      const alias = JSON.parse(data);
      if (alias.did === did) {
        aliases.push(alias);
      }
    }
    
    return aliases;
  }
  
  async listActive(): Promise<AtAliasRecord[]> {
    const keys = await this.redis.keys(`${this.prefix}canonical:*`);
    const aliases: AtAliasRecord[] = [];
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      const alias = JSON.parse(data);
      if (!alias.deletedAt) {
        aliases.push(alias);
      }
    }
    
    return aliases;
  }
}
