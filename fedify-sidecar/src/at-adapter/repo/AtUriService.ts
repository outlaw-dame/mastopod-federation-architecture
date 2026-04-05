/**
 * V6.5 Phase 3: ATProto URI Service
 *
 * Constructs AT URIs for records in the format:
 * at://{did}/{collection}/{rkey}
 *
 * AT URIs are the canonical way to reference records in ATProto repositories.
 */

/**
 * ATProto URI Service
 *
 * Constructs and validates AT URIs.
 */
export interface AtUriService {
  /**
   * Construct AT URI for a record
   *
   * @param did - Repository DID
   * @param collection - Record collection (e.g., app.bsky.feed.post)
   * @param rkey - Record key
   * @returns AT URI (e.g., at://did:plc:xxx/app.bsky.feed.post/abc123)
   */
  makeAtUri(did: string, collection: string, rkey: string): string;

  /**
   * Parse AT URI into components
   *
   * @param uri - AT URI to parse
   * @returns Parsed components or null if invalid
   */
  parseAtUri(uri: string): AtUriComponents | null;
}

/**
 * Parsed AT URI components
 */
export interface AtUriComponents {
  did: string;
  collection: string;
  rkey: string;
}

/**
 * Default implementation
 */
export class DefaultAtUriService implements AtUriService {
  /**
   * Construct AT URI
   *
   * Format: at://{did}/{collection}/{rkey}
   */
  makeAtUri(did: string, collection: string, rkey: string): string {
    if (!did.startsWith('did:')) {
      throw new Error(`Invalid DID: ${did}`);
    }

    if (!collection.includes('.')) {
      throw new Error(`Invalid collection NSID: ${collection}`);
    }

    if (rkey.length === 0 || rkey.length > 256) {
      throw new Error(`Invalid rkey: ${rkey}`);
    }

    return `at://${did}/${collection}/${rkey}`;
  }

  /**
   * Parse AT URI
   *
   * Supports both DID and handle-based URIs:
   * - at://did:plc:xxx/app.bsky.feed.post/abc123
   * - at://alice.bsky.social/app.bsky.feed.post/abc123
   */
  parseAtUri(uri: string): AtUriComponents | null {
    if (!uri.startsWith('at://')) {
      return null;
    }

    const withoutScheme = uri.slice(5);
    const parts = withoutScheme.split('/');

    if (parts.length < 3) {
      return null;
    }

    const [authority, collection, rkey] = parts;

    if (!authority) {
      return null;
    }

    if (!collection || !collection.includes('.')) {
      return null;
    }

    if (!rkey) {
      return null;
    }

    return {
      did: authority,
      collection,
      rkey,
    };
  }
}

/**
 * Validate AT URI format
 */
export function validateAtUri(uri: string): boolean {
  if (!uri.startsWith('at://')) {
    return false;
  }

  const service = new DefaultAtUriService();
  return service.parseAtUri(uri) !== null;
}

/**
 * Extract DID from AT URI
 */
export function extractDidFromAtUri(uri: string): string | null {
  const service = new DefaultAtUriService();
  const parsed = service.parseAtUri(uri);
  return parsed ? parsed.did : null;
}

/**
 * Extract collection from AT URI
 */
export function extractCollectionFromAtUri(uri: string): string | null {
  const service = new DefaultAtUriService();
  const parsed = service.parseAtUri(uri);
  return parsed ? parsed.collection : null;
}

/**
 * Extract rkey from AT URI
 */
export function extractRkeyFromAtUri(uri: string): string | null {
  const service = new DefaultAtUriService();
  const parsed = service.parseAtUri(uri);
  return parsed ? parsed.rkey : null;
}
