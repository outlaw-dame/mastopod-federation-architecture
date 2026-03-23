/**
 * V6.5 Alias Projection Service - ActivityPub alsoKnownAs Management
 *
 * Manages the ActivityPub alsoKnownAs property which lists other identities
 * associated with an actor. This enables discovery of dual-protocol identities.
 *
 * Projections:
 * - ActivityPub actor -> ATProto DID (at://did:plc:xxx)
 * - ActivityPub actor -> ATProto handle (at://handle.example)
 * - ActivityPub actor -> WebID (https://pod.example/profile/card#me)
 */

import { IdentityBinding } from '../identity/IdentityBinding.js';

/**
 * Alias projection types
 */
export type AliasType = 'atproto_did' | 'atproto_handle' | 'webid' | 'custom';

/**
 * Alias projection
 */
export interface AliasProjection {
  /**
   * Type of alias
   */
  type: AliasType;

  /**
   * The alias URI/identifier
   */
  uri: string;

  /**
   * Whether this alias is verified
   */
  verified: boolean;

  /**
   * ISO 8601 timestamp of verification
   */
  verifiedAt?: string;

  /**
   * TTL for verification (in seconds)
   */
  verificationTtl?: number;
}

/**
 * Alias Projection Service
 *
 * Manages ActivityPub alsoKnownAs projections for dual-protocol identities.
 */
export class AliasProjectionService {
  /**
   * Generate alias projections for an identity binding
   *
   * @param binding - The identity binding
   * @returns Array of alias projections
   */
  generateAliasProjections(binding: IdentityBinding): AliasProjection[] {
    const projections: AliasProjection[] = [];

    // ATProto DID alias
    if (binding.atprotoDid) {
      projections.push({
        type: 'atproto_did',
        uri: `at://${binding.atprotoDid}`,
        verified: !!binding.atprotoDid,
        verifiedAt: binding.updatedAt,
      });
    }

    // ATProto handle alias
    if (binding.atprotoHandle) {
      projections.push({
        type: 'atproto_handle',
        uri: `at://${binding.atprotoHandle}`,
        verified: !!binding.atprotoHandle,
        verifiedAt: binding.updatedAt,
      });
    }

    // WebID alias
    if (binding.webId) {
      projections.push({
        type: 'webid',
        uri: binding.webId,
        verified: true,
        verifiedAt: binding.createdAt,
      });
    }

    // Custom aliases from account links
    for (const customAlias of binding.accountLinks.apAlsoKnownAs) {
      projections.push({
        type: 'custom',
        uri: customAlias,
        verified: false,
      });
    }

    return projections;
  }

  /**
   * Update alias projections in ActivityPub actor document
   *
   * @param actorDocument - The actor document (JSON-LD)
   * @param projections - The alias projections
   * @returns Updated actor document
   */
  updateActorAlsoKnownAs(
    actorDocument: Record<string, any>,
    projections: AliasProjection[]
  ): Record<string, any> {
    const updated = { ...actorDocument };

    // Filter to only verified aliases
    const verifiedAliases = projections
      .filter((p) => p.verified)
      .map((p) => p.uri);

    if (verifiedAliases.length > 0) {
      updated.alsoKnownAs = verifiedAliases;
    } else {
      delete updated.alsoKnownAs;
    }

    return updated;
  }

  /**
   * Extract aliases from ActivityPub actor document
   *
   * @param actorDocument - The actor document
   * @returns Array of alias URIs
   */
  extractAliasesFromActor(actorDocument: Record<string, any>): string[] {
    if (!actorDocument.alsoKnownAs) {
      return [];
    }

    if (Array.isArray(actorDocument.alsoKnownAs)) {
      return actorDocument.alsoKnownAs;
    }

    if (typeof actorDocument.alsoKnownAs === 'string') {
      return [actorDocument.alsoKnownAs];
    }

    return [];
  }

  /**
   * Validate alias format
   *
   * @param alias - The alias to validate
   * @returns true if valid
   */
  isValidAlias(alias: string): boolean {
    // Must be a valid URI
    try {
      new URL(alias);
      return true;
    } catch {
      // Try at:// scheme
      if (alias.startsWith('at://')) {
        return true;
      }
      return false;
    }
  }

  /**
   * Parse alias type and value
   *
   * @param alias - The alias URI
   * @returns Parsed alias or null if invalid
   */
  parseAlias(alias: string): { type: AliasType; value: string } | null {
    // ATProto DID
    if (alias.startsWith('at://did:')) {
      return {
        type: 'atproto_did',
        value: alias.substring(5), // Remove 'at://'
      };
    }

    // ATProto handle
    if (alias.startsWith('at://')) {
      return {
        type: 'atproto_handle',
        value: alias.substring(5), // Remove 'at://'
      };
    }

    // WebID or other HTTP(S) URI
    if (alias.startsWith('http://') || alias.startsWith('https://')) {
      if (alias.includes('/profile/card#me')) {
        return {
          type: 'webid',
          value: alias,
        };
      }
      return {
        type: 'custom',
        value: alias,
      };
    }

    return null;
  }

  /**
   * Merge alias projections, deduplicating and prioritizing verified ones
   *
   * @param existing - Existing projections
   * @param updated - Updated projections
   * @returns Merged projections
   */
  mergeAliasProjections(
    existing: AliasProjection[],
    updated: AliasProjection[]
  ): AliasProjection[] {
    const map = new Map<string, AliasProjection>();

    // Add existing
    for (const proj of existing) {
      map.set(proj.uri, proj);
    }

    // Add/update with new
    for (const proj of updated) {
      const existing = map.get(proj.uri);
      if (!existing || proj.verified) {
        map.set(proj.uri, proj);
      }
    }

    return Array.from(map.values());
  }

  /**
   * Check if alias is stale (verification expired)
   *
   * @param projection - The projection
   * @returns true if stale
   */
  isAliasStale(projection: AliasProjection): boolean {
    if (!projection.verifiedAt || !projection.verificationTtl) {
      return false;
    }

    const verifiedTime = new Date(projection.verifiedAt).getTime();
    const ttlMs = projection.verificationTtl * 1000;
    const expiryTime = verifiedTime + ttlMs;
    const now = Date.now();

    return now > expiryTime;
  }

  /**
   * Refresh stale aliases
   *
   * @param projections - The projections
   * @returns Projections with stale flags updated
   */
  refreshStaleAliases(projections: AliasProjection[]): AliasProjection[] {
    return projections.map((proj) => ({
      ...proj,
      verified: proj.verified && !this.isAliasStale(proj),
    }));
  }
}
