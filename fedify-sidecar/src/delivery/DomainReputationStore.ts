/**
 * DomainReputationStore
 *
 * Tracks domains that should be treated with suspicion (spam / reputation).
 * Two Redis sets are maintained:
 *
 *   spam:domain-block:exact:v1  — exact hostname matches (e.g. "spam.example.com")
 *   spam:domain-block:sub:v1    — subdomain-inclusive matches (e.g. "example.com"
 *                                  also blocks "sub.example.com")
 *
 * isDomainBlocked is fail-open: Redis errors never cause content to be blocked.
 * Domains are sanitized before storage: lowercase, no port, validated hostname.
 */

import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const EXACT_KEY = "spam:domain-block:exact:v1";
const SUB_KEY = "spam:domain-block:sub:v1";
const MAX_DOMAIN_LEN = 253;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainEntry {
  domain: string;
  subdomainMatch: boolean;
}

export interface DomainReputationStore {
  isDomainBlocked(domain: string): Promise<boolean>;
  listDomains(): Promise<DomainEntry[]>;
  addDomain(domain: string, subdomainMatch: boolean): Promise<void>;
  removeDomain(domain: string, subdomainMatch: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

// Reject IPv4, IPv6 brackets, and anything that isn't a valid DNS label sequence.
const LABEL_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function sanitizeDomain(raw: string): string | null {
  let d = raw.toLowerCase().trim();
  if (!d) return null;

  // Strip port if present (e.g. "example.com:8080")
  const colonIdx = d.lastIndexOf(":");
  if (colonIdx > 0) {
    const after = d.slice(colonIdx + 1);
    if (/^\d{1,5}$/.test(after)) d = d.slice(0, colonIdx);
  }

  if (d.length > MAX_DOMAIN_LEN) return null;

  // Reject raw IP addresses
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d) || d.startsWith("[")) return null;

  if (!LABEL_RE.test(d)) return null;

  return d;
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export class RedisDomainReputationStore implements DomainReputationStore {
  constructor(private readonly redis: Redis) {}

  async isDomainBlocked(domain: string): Promise<boolean> {
    try {
      const d = sanitizeDomain(domain);
      if (!d) return false;

      // Exact match
      if (await this.redis.sismember(EXACT_KEY, d)) return true;

      // Subdomain match: walk from d upward toward TLD, checking sub set.
      // e.g. "a.b.c.example.com" checks "a.b.c.example.com", "b.c.example.com",
      //      "c.example.com", "example.com" — stops before TLD-only.
      const parts = d.split(".");
      for (let i = 0; i < parts.length - 1; i++) {
        const candidate = parts.slice(i).join(".");
        if (await this.redis.sismember(SUB_KEY, candidate)) return true;
      }

      return false;
    } catch {
      // Fail-open: infrastructure error must not cause false blocks.
      return false;
    }
  }

  async listDomains(): Promise<DomainEntry[]> {
    try {
      const [exactMembers, subMembers] = await Promise.all([
        this.redis.smembers(EXACT_KEY),
        this.redis.smembers(SUB_KEY),
      ]);

      const entries: DomainEntry[] = [
        ...exactMembers.map((domain) => ({ domain, subdomainMatch: false })),
        ...subMembers.map((domain) => ({ domain, subdomainMatch: true })),
      ];

      entries.sort((a, b) => a.domain.localeCompare(b.domain));
      return entries;
    } catch {
      return [];
    }
  }

  async addDomain(domain: string, subdomainMatch: boolean): Promise<void> {
    const d = sanitizeDomain(domain);
    if (!d) throw new Error(`Invalid domain: "${domain}"`);
    await this.redis.sadd(subdomainMatch ? SUB_KEY : EXACT_KEY, d);
  }

  async removeDomain(domain: string, subdomainMatch: boolean): Promise<void> {
    const d = sanitizeDomain(domain);
    if (!d) throw new Error(`Invalid domain: "${domain}"`);
    await this.redis.srem(subdomainMatch ? SUB_KEY : EXACT_KEY, d);
  }
}
