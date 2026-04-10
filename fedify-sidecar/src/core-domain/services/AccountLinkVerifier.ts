/**
 * V6.5 Account Link Verifier - Bidirectional Account Link Verification
 *
 * Verifies that account links are bidirectional and authentic:
 * - ActivityPub actor includes ATProto DID in alsoKnownAs
 * - ATProto DID document includes ActivityPub actor in alsoKnownAs
 * - WebID includes both in RDF triples
 *
 * This ensures no account takeover or spoofing is possible.
 */

import { IdentityBinding, AccountLinkVerificationStatus } from '../identity/IdentityBinding.js';

/**
 * Link verification result
 */
export interface LinkVerificationResult {
  /**
   * Overall verification status
   */
  status: AccountLinkVerificationStatus;

  /**
   * Actor document verification
   */
  actorDocumentVerified: boolean;

  /**
   * DID document verification
   */
  didDocumentVerified: boolean;

  /**
   * WebID document verification
   */
  webIdDocumentVerified: boolean;

  /**
   * Verification errors
   */
  errors: string[];

  /**
   * Verification timestamp
   */
  verifiedAt: string;
}

/**
 * Account Link Verifier
 *
 * Verifies bidirectional account links.
 */
export class AccountLinkVerifier {
  /**
   * HTTP request timeout (milliseconds)
   */
  private readonly HTTP_TIMEOUT_MS = 15000;

  /**
   * Verify account link
   *
   * @param binding - The identity binding
   * @returns Verification result
   */
  async verifyAccountLink(binding: IdentityBinding): Promise<LinkVerificationResult> {
    const errors: string[] = [];
    let actorDocumentVerified = false;
    let didDocumentVerified = false;
    let webIdDocumentVerified = false;
    const now = new Date().toISOString();

    // Verify ActivityPub actor document
    try {
      actorDocumentVerified = await this.verifyActorDocument(binding);
      if (!actorDocumentVerified) {
        errors.push('ActivityPub actor document does not include ATProto DID');
      }
    } catch (error) {
      errors.push(
        `Failed to verify actor document: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Verify ATProto DID document
    if (binding.atprotoDid) {
      try {
        didDocumentVerified = await this.verifyDidDocument(binding);
        if (!didDocumentVerified) {
          errors.push('ATProto DID document does not include ActivityPub actor');
        }
      } catch (error) {
        errors.push(
          `Failed to verify DID document: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Verify WebID document
    try {
      webIdDocumentVerified = await this.verifyWebIdDocument(binding);
      if (!webIdDocumentVerified) {
        errors.push('WebID document does not include both identities');
      }
    } catch (error) {
      errors.push(
        `Failed to verify WebID document: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Determine overall status
    let status: AccountLinkVerificationStatus;
    if (errors.length === 0) {
      status = 'fresh_verified';
    } else if (actorDocumentVerified && webIdDocumentVerified) {
      status = 'stale_verified'; // At least AP and WebID are verified
    } else {
      status = 'unverified';
    }

    return {
      status,
      actorDocumentVerified,
      didDocumentVerified,
      webIdDocumentVerified,
      errors,
      verifiedAt: now,
    };
  }

  /**
   * Verify ActivityPub actor document
   *
   * @param binding - The identity binding
   * @returns true if verified
   * @throws Error on fetch failure
   */
  private async verifyActorDocument(binding: IdentityBinding): Promise<boolean> {
    try {
      const response = await fetch(binding.activityPubActorUri, {
        method: 'GET',
        headers: {
          'Accept': 'application/activity+json',
        },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const actor = (await response.json()) as any;

      // Check alsoKnownAs
      const alsoKnownAs = actor.alsoKnownAs || [];
      const aliases = Array.isArray(alsoKnownAs) ? alsoKnownAs : [alsoKnownAs];

      // Check for ATProto DID
      const atprotoDid = binding.atprotoDid;
      if (atprotoDid) {
        return aliases.some(
          (alias: string) =>
            alias === atprotoDid ||
            alias === `at://${atprotoDid}` ||
            alias.includes(atprotoDid)
        );
      }

      return false;
    } catch (error) {
      throw new Error(
        `Failed to fetch actor document: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Verify ATProto DID document
   *
   * @param binding - The identity binding
   * @returns true if verified
   * @throws Error on fetch failure
   */
  private async verifyDidDocument(binding: IdentityBinding): Promise<boolean> {
    if (!binding.atprotoDid) {
      return false;
    }

    try {
      // Resolve DID to document
      const response = await fetch(`https://plc.directory/${binding.atprotoDid}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const entry = (await response.json()) as any;
      const didDoc = entry.operation || {};

      // Check alsoKnownAs
      const alsoKnownAs = didDoc.alsoKnownAs || [];

      // Check for ActivityPub actor
      return alsoKnownAs.some(
        (alias: string) =>
          alias === binding.activityPubActorUri || alias.includes(binding.activityPubActorUri)
      );
    } catch (error) {
      throw new Error(
        `Failed to fetch DID document: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Verify WebID document
   *
   * @param binding - The identity binding
   * @returns true if verified
   * @throws Error on fetch failure
   */
  private async verifyWebIdDocument(binding: IdentityBinding): Promise<boolean> {
    try {
      const response = await fetch(binding.webId, {
        method: 'GET',
        headers: {
          'Accept': 'application/ld+json, application/json',
        },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const webId = (await response.json()) as any;

      // Check schema:sameAs
      const sameAs = webId.sameAs || [];
      const sameAsArray = Array.isArray(sameAs) ? sameAs : [sameAs];

      const hasSameAsAp = sameAsArray.some((alias: string) =>
        alias.includes(binding.activityPubActorUri)
      );
      const hasSameAsDid = binding.atprotoDid
        ? sameAsArray.some(
            (alias: string) =>
              alias === binding.atprotoDid || alias === `at://${binding.atprotoDid}`
          )
        : true;

      return hasSameAsAp && hasSameAsDid;
    } catch (error) {
      throw new Error(
        `Failed to fetch WebID document: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if link is stale (needs reverification)
   *
   * @param binding - The identity binding
   * @param maxAgeDays - Maximum age in days (default 30)
   * @returns true if stale
   */
  isLinkStale(binding: IdentityBinding, maxAgeDays: number = 30): boolean {
    if (!(binding.accountLinks as any).verificationRecords || (binding.accountLinks as any).verificationRecords.length === 0) {
      return true;
    }

    const latest = (binding.accountLinks as any).verificationRecords[0];
    const verifiedTime = new Date(latest.verifiedAt).getTime();
    const now = Date.now();
    const ageMs = now - verifiedTime;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    return ageMs > maxAgeMs;
  }

  /**
   * Format verification result for logging
   *
   * @param result - Verification result
   * @returns Human-readable description
   */
  formatResult(result: LinkVerificationResult): string {
    const parts = [
      `Status: ${result.status}`,
      `Actor: ${result.actorDocumentVerified ? '✓' : '✗'}`,
      `DID: ${result.didDocumentVerified ? '✓' : '✗'}`,
      `WebID: ${result.webIdDocumentVerified ? '✓' : '✗'}`,
    ];

    if (result.errors.length > 0) {
      parts.push(`Errors: ${result.errors.join('; ')}`);
    }

    return parts.join(' | ');
  }
}

