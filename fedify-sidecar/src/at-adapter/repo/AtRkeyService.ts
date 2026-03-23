/**
 * V6.5 Phase 3: ATProto Record Key Service
 *
 * Deterministic rkey allocation for AT records:
 * - Profiles: fixed "self" rkey
 * - Posts: TID-based rkey from timestamp
 * - Updates: reuse existing rkey
 * - Deletes: require prior alias lookup
 */

/**
 * TID (Timestamp Identifier) - 13-character base32-encoded timestamp + random
 * Used for posts and other time-ordered records
 */
export function generateTidFromTimestamp(publishedAt: string): string {
  const timestamp = new Date(publishedAt).getTime();
  
  // TID format: 53-bit timestamp (milliseconds since epoch) + 10-bit random
  // Encoded as 13-character base32
  const timestampBits = BigInt(timestamp) << 10n;
  const randomBits = BigInt(Math.floor(Math.random() * 1024));
  const tidValue = timestampBits | randomBits;
  
  // Convert to base32
  return encodeBase32(tidValue);
}

/**
 * Encode BigInt as base32 (RFC 4648 alphabet)
 */
function encodeBase32(value: bigint): string {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
  let result = '';
  let n = value;
  
  while (n > 0n) {
    result = alphabet[Number(n & 31n)] + result;
    n = n >> 5n;
  }
  
  // Pad to 13 characters
  return result.padStart(13, '2');
}

/**
 * ATProto Record Key Service
 *
 * Allocates deterministic record keys for different collection types.
 */
export interface AtRkeyService {
  /**
   * Get rkey for profile record (always "self")
   */
  profileRkey(): string;
  
  /**
   * Allocate rkey for new post record (TID-based)
   */
  postRkey(publishedAt: string): string;
}

/**
 * Default implementation
 */
export class DefaultAtRkeyService implements AtRkeyService {
  /**
   * Profile records use fixed "self" rkey
   * This ensures there's only one profile record per repository
   */
  profileRkey(): string {
    return 'self';
  }
  
  /**
   * Post records use TID-based rkey
   * TIDs are timestamp-based, ensuring temporal ordering
   */
  postRkey(publishedAt: string): string {
    return generateTidFromTimestamp(publishedAt);
  }
}

/**
 * Validate rkey format
 */
export function validateRkey(rkey: string): boolean {
  // rkey must be 1-256 characters, alphanumeric + hyphen
  if (rkey.length === 0 || rkey.length > 256) {
    return false;
  }
  
  return /^[a-zA-Z0-9_-]+$/.test(rkey);
}
