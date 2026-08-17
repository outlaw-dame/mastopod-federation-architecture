/**
 * RemoteSharedInboxCache compatibility shim.
 *
 * Shared-inbox authority now comes from the durable APDM delivery target that
 * ActivityPods/SemApps resolved for the recipient. The sidecar must not infer a
 * shared inbox from a hostname, derive an actor URL from an inbox URL, or
 * dereference a remote actor merely to optimize delivery.
 *
 * This class is retained temporarily so older construction code can compile
 * while the startup wiring is removed independently. Every method is therefore
 * deliberately side-effect free: no Redis access, no remote HTTP fetches, and
 * no mutation of the supplied delivery target snapshot.
 */

import type { Redis } from "ioredis";

export type SharedInboxCompatibleTarget = {
  inboxUrl: string;
  sharedInboxUrl?: string;
  deliveryUrl: string;
  targetDomain: string;
};

/**
 * @deprecated APDM targets already carry the authoritative optional
 * `sharedInboxUrl`. Callers should normalize/deduplicate those targets directly
 * and fall back to `inboxUrl` when `sharedInboxUrl` is absent.
 */
export class RemoteSharedInboxCache {
  constructor(
    _redis: Redis,
    _userAgent: string,
    _ttlSeconds?: number,
  ) {}

  /**
   * Preserve the exact target snapshot supplied by the caller.
   *
   * This intentionally performs no discovery. In particular, two actors on the
   * same hostname are never assumed to share an inbox unless Tier 1 supplied
   * the same exact `sharedInboxUrl` for both. Return a fresh array, matching the
   * old Promise.all-based allocation behavior without cloning target objects.
   */
  async enrichTargets<T extends SharedInboxCompatibleTarget>(targets: T[]): Promise<T[]> {
    return [...targets];
  }

  /**
   * Retained only for source compatibility with older callers.
   *
   * Domain-level shared-inbox resolution is not an authority-safe operation, so
   * this method always reports "unknown" and performs no I/O.
   */
  async resolveForDomain(_domain: string, _inboxUrl: string): Promise<string | null> {
    return null;
  }

  /**
   * There is no sidecar-owned shared-inbox cache left to invalidate.
   */
  async invalidate(_domain: string): Promise<void> {}
}

/**
 * Legacy pure helper retained for source compatibility only.
 *
 * It must not be used as evidence that an inbox URL authoritatively identifies
 * an actor document. The APDM delivery path no longer calls it.
 */
export function deriveActorUrl(inboxUrl: string): string | null {
  try {
    const parsed = new URL(inboxUrl);
    if (parsed.protocol !== "https:") return null;

    const path = parsed.pathname;
    if (!path.endsWith("/inbox")) return null;

    parsed.pathname = path.slice(0, -"/inbox".length) || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}
