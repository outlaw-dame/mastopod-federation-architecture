/**
 * FEP-8fcf: Collection-Synchronization HTTP header parser, serializer, and validator.
 *
 * Header format (same key="value" parameter syntax as HTTP Signatures):
 *   Collection-Synchronization: collectionId="...", url="...", digest="..."
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/8fcf/fep-8fcf.md
 */

// ============================================================================
// Types
// ============================================================================

export interface CollectionSyncParams {
  /** The sender's followers collection URI. */
  collectionId: string;
  /**
   * URL of the partial followers collection scoped to the receiving instance.
   * Must share the same origin as collectionId.
   */
  url: string;
  /**
   * Lowercase hex-encoded XOR-SHA256 digest of all follower IDs from the
   * receiving instance.
   */
  digest: string;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a raw Collection-Synchronization header value into its constituent
 * parameters.  Returns null if the value is missing any required field or
 * cannot be parsed.
 */
export function parseCollectionSyncHeader(headerValue: string): CollectionSyncParams | null {
  const params: Record<string, string> = {};
  // Matches key="value" pairs; the regex is the same as used for HTTP Signatures.
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(headerValue)) !== null) {
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) {
      params[k] = v;
    }
  }

  const { collectionId, url, digest } = params;
  if (
    typeof collectionId !== "string" || collectionId.length === 0 ||
    typeof url !== "string" || url.length === 0 ||
    typeof digest !== "string" || digest.length === 0
  ) {
    return null;
  }

  return { collectionId, url, digest };
}

// ============================================================================
// Serialization
// ============================================================================

/** Serialize a CollectionSyncParams object into a header value string. */
export function serializeCollectionSyncHeader(params: CollectionSyncParams): string {
  return `collectionId="${params.collectionId}", url="${params.url}", digest="${params.digest}"`;
}

// ============================================================================
// Validation
// ============================================================================

export type CollectionSyncValidation =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validate a parsed Collection-Synchronization header per FEP-8fcf §3.2.
 *
 * Rules checked:
 *  1. collectionId must equal the sender's followers collection URI.
 *  2. url must share the same origin as collectionId (prevents SSRF tricks where
 *     the sender tricks the receiver into fetching a third-party resource).
 *
 * @param params           Parsed header parameters.
 * @param senderFollowersUri  The sender's followers collection URI as declared
 *                            in their actor document (authoritative reference).
 */
export function validateCollectionSyncHeader(
  params: CollectionSyncParams,
  senderFollowersUri: string,
): CollectionSyncValidation {
  // Rule 1: collectionId must match the sender's followers collection.
  if (params.collectionId !== senderFollowersUri) {
    return {
      valid: false,
      reason: `collectionId "${params.collectionId}" does not match sender followers collection "${senderFollowersUri}"`,
    };
  }

  // Rule 2: url must share origin with collectionId.
  let collectionOrigin: string;
  let syncOrigin: string;
  try {
    collectionOrigin = new URL(params.collectionId).origin;
    syncOrigin = new URL(params.url).origin;
  } catch {
    return { valid: false, reason: "collectionId or url is not a valid URL" };
  }

  if (collectionOrigin !== syncOrigin) {
    return {
      valid: false,
      reason: `url origin "${syncOrigin}" does not match collectionId origin "${collectionOrigin}"`,
    };
  }

  return { valid: true };
}

// ============================================================================
// Helpers
// ============================================================================

/** Header name (lowercase, as used by HTTP/1.1 and Fastify). */
export const COLLECTION_SYNC_HEADER = "collection-synchronization";

/**
 * Attempt to extract the sender's followers collection URI from a raw
 * ActivityStreams actor document.  Falls back to the conventional
 * `{actorUri}/followers` path if the document does not declare one.
 */
export function extractFollowersUri(
  actorDocument: Record<string, unknown>,
  actorUri: string,
): string {
  const followers = actorDocument["followers"];
  if (typeof followers === "string" && followers.length > 0) {
    return followers;
  }
  if (
    typeof followers === "object" &&
    followers !== null &&
    typeof (followers as Record<string, unknown>)["id"] === "string"
  ) {
    return (followers as Record<string, unknown>)["id"] as string;
  }
  // Conventional fallback used by Mastodon and most AP implementations.
  return `${actorUri}/followers`;
}
