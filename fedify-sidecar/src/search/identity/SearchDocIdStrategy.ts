/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * Document Identity Strategy (CRITICAL)
 * 
 * Rule 1 — Local content (authoritative)
 * stableDocId = canonicalContentId
 * 
 * Rule 2 — Remote content
 * Fallback hierarchy:
 * 1. existing merged doc via alias
 * 2. if none:
 *    - AP: use ap.objectUri
 *    - AT: use at.uri
 */

export class SearchDocIdStrategy {
  /**
   * Generate a stable document ID for local content.
   * Local content ALWAYS uses the canonical ID.
   */
  static forLocal(canonicalContentId: string): string {
    return canonicalContentId;
  }

  /**
   * Generate a stable document ID for remote AP content.
   * Used when no existing merged document is found.
   */
  static forRemoteAp(apObjectUri: string): string {
    return `ap:${apObjectUri}`;
  }

  /**
   * Generate a stable document ID for remote AT content.
   * Used when no existing merged document is found.
   */
  static forRemoteAt(atUri: string): string {
    return `at:${atUri}`;
  }
}
