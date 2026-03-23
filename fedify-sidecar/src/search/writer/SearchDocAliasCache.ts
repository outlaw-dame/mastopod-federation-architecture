/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * Redis alias cache layer for fast dedup lookup and merge decisions.
 */

export interface SearchDocAliasCache {
  /**
   * Get stableDocId by canonical ID
   */
  getByCanonicalId(canonicalId: string): Promise<string | null>;

  /**
   * Get stableDocId by AP URI
   */
  getByApUri(apUri: string): Promise<string | null>;

  /**
   * Get stableDocId by AT URI
   */
  getByAtUri(atUri: string): Promise<string | null>;

  /**
   * Set mapping for canonical ID
   */
  setCanonicalId(canonicalId: string, stableDocId: string): Promise<void>;

  /**
   * Set mapping for AP URI
   */
  setApUri(apUri: string, stableDocId: string): Promise<void>;

  /**
   * Set mapping for AT URI
   */
  setAtUri(atUri: string, stableDocId: string): Promise<void>;
}

export class InMemorySearchDocAliasCache implements SearchDocAliasCache {
  private canonicalMap = new Map<string, string>();
  private apMap = new Map<string, string>();
  private atMap = new Map<string, string>();

  async getByCanonicalId(canonicalId: string): Promise<string | null> {
    return this.canonicalMap.get(canonicalId) || null;
  }

  async getByApUri(apUri: string): Promise<string | null> {
    return this.apMap.get(apUri) || null;
  }

  async getByAtUri(atUri: string): Promise<string | null> {
    return this.atMap.get(atUri) || null;
  }

  async setCanonicalId(canonicalId: string, stableDocId: string): Promise<void> {
    this.canonicalMap.set(canonicalId, stableDocId);
  }

  async setApUri(apUri: string, stableDocId: string): Promise<void> {
    this.apMap.set(apUri, stableDocId);
  }

  async setAtUri(atUri: string, stableDocId: string): Promise<void> {
    this.atMap.set(atUri, stableDocId);
  }
}

export class RedisSearchDocAliasCache implements SearchDocAliasCache {
  constructor(private readonly redis: any) {}

  async getByCanonicalId(canonicalId: string): Promise<string | null> {
    return this.redis.get(`search:doc:canonical:${canonicalId}`);
  }

  async getByApUri(apUri: string): Promise<string | null> {
    return this.redis.get(`search:doc:ap:${apUri}`);
  }

  async getByAtUri(atUri: string): Promise<string | null> {
    return this.redis.get(`search:doc:at:${atUri}`);
  }

  async setCanonicalId(canonicalId: string, stableDocId: string): Promise<void> {
    await this.redis.set(`search:doc:canonical:${canonicalId}`, stableDocId);
  }

  async setApUri(apUri: string, stableDocId: string): Promise<void> {
    await this.redis.set(`search:doc:ap:${apUri}`, stableDocId);
  }

  async setAtUri(atUri: string, stableDocId: string): Promise<void> {
    await this.redis.set(`search:doc:at:${atUri}`, stableDocId);
  }
}
