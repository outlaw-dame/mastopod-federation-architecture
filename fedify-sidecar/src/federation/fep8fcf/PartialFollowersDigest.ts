/**
 * FEP-8fcf: Partial follower collection digest.
 *
 * The digest is computed by XOR-ing the SHA-256 hashes of each follower's URI:
 *
 *   digest = SHA256(follower1) XOR SHA256(follower2) XOR … XOR SHA256(followerN)
 *
 * The result is a 64-character lowercase hex string (32 bytes).  An empty
 * follower set yields a string of 64 zero hex characters.
 *
 * XOR was chosen so the digest is order-independent (sets, not sequences).
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/8fcf/fep-8fcf.md
 */

import { createHash } from "node:crypto";

// ============================================================================
// Digest computation
// ============================================================================

/**
 * Compute the FEP-8fcf partial followers digest for a set of follower URIs.
 *
 * @param followerIds  Array of follower actor URI strings.  Order does not
 *                    matter — the XOR operation is commutative.
 * @returns           64-character lowercase hex string.
 */
export function computePartialFollowersDigest(followerIds: string[]): string {
  const acc = Buffer.alloc(32, 0);

  for (const id of followerIds) {
    const h = createHash("sha256").update(id, "utf8").digest();
    for (let i = 0; i < 32; i++) {
      acc[i] = (acc[i] ?? 0) ^ (h[i] ?? 0);
    }
  }

  return acc.toString("hex");
}

// ============================================================================
// Filtering helpers
// ============================================================================

/**
 * Return the subset of `followerIds` whose URI origin matches `targetOrigin`.
 *
 * Per FEP-8fcf §2, the "partial followers collection for instance X" is the
 * subset of followers whose `id` shares X's URI scheme and authority
 * (i.e. `new URL(id).origin === new URL(targetOrigin).origin`).
 *
 * @param followerIds    Full list of follower URIs.
 * @param targetOrigin   The origin to filter by, e.g. `"https://remote.example.com"`.
 *                       Scheme + host (+ non-standard port).  Query/path ignored.
 */
export function filterFollowersByOrigin(followerIds: string[], targetOrigin: string): string[] {
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(targetOrigin).origin;
  } catch {
    return [];
  }

  return followerIds.filter((id) => {
    try {
      return new URL(id).origin === normalizedOrigin;
    } catch {
      return false;
    }
  });
}

/**
 * Extract the URL origin from a URI string.
 * Returns null if the URI cannot be parsed.
 */
export function extractOrigin(uri: string): string | null {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

/**
 * Extract a sidecar-local actor identifier from a full actor URI.
 *
 * Assumes the convention `https://{domain}/users/{identifier}` used throughout
 * the sidecar.  Returns null if the URI does not match this pattern.
 *
 * @example
 *   extractActorIdentifier("https://example.com/users/alice", "example.com") // "alice"
 *   extractActorIdentifier("https://example.com/relay",      "example.com") // null
 */
export function extractActorIdentifier(actorUri: string, domain: string): string | null {
  try {
    const url = new URL(actorUri);
    if (url.hostname !== domain) return null;
    const match = url.pathname.match(/^\/users\/([^/?#]+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
