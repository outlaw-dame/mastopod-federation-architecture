/**
 * V6.5 Provisioning Orchestrator - Dual-Protocol Identity Provisioning
 *
 * Orchestrates the end-to-end provisioning of dual-protocol identities:
 * 1. Create ActivityPub identity (WebID + actor)
 * 2. Generate signing keys
 * 3. Provision ATProto identity (DID + handle)
 * 4. Set up projections (aliases, RDF links)
 * 5. Verify bidirectional links
 * 6. Emit provisioning events
 *
 * This is the primary entry point for account creation workflows.
 */

import { IdentityBindingService } from '../services/IdentityBindingService.js';
import { AliasProjectionService } from '../services/AliasProjectionService.js';
import { WebIdProjectionService } from '../services/WebIdProjectionService.js';
import { IdentityBinding } from '../identity/IdentityBinding.js';

/**
 * Provisioning request
 */
export interface ProvisioningRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * Pod/context ID
   */
  contextId: string;

  /**
   * Username for the account
   */
  username: string;

  /**
   * Pod domain
   */
  podDomain: string;

  /**
   * ATProto handle
   */
  atprotoHandle: string;

  /**
   * Canonical DID method
   */
  canonicalDidMethod: 'did:plc' | 'did:web';

  /**
   * ATProto PDS endpoint
   */
  atprotoPdsEndpoint: string;

  /**
   * Optional: Display name
   */
  displayName?: string;

  /**
   * Optional: Avatar URL
   */
  avatar?: string;

  /**
   * Optional: Bio/summary
   */
  summary?: string;
}

/**
 * Provisioning result
 */
export interface ProvisioningResult {
  /**
   * The provisioned identity binding
   */
  binding: IdentityBinding;

  /**
   * Generated ActivityPub actor document
   */
  actorDocument: Record<string, any>;

  /**
   * Generated WebID document
   */
  webIdDocument: Record<string, any>;

  /**
   * Alias projections
   */
  aliases: Array<{
    type: string;
    uri: string;
    verified: boolean;
  }>;

  /**
   * RDF triples for identity linking
   */
  rdfTriples: Array<{
    subject: string;
    predicate: string;
    object: string;
  }>;

  /**
   * Provisioning status
   */
  status: 'success' | 'partial' | 'failed';

  /**
   * Any errors that occurred
   */
  errors: string[];
}

/**
 * Provisioning Orchestrator
 *
 * Coordinates the provisioning of dual-protocol identities.
 */
export class ProvisioningOrchestrator {
  constructor(
    private identityService: IdentityBindingService,
    private aliasService: AliasProjectionService,
    private webIdService: WebIdProjectionService
  ) {}

  /**
   * Provision a new dual-protocol identity
   *
   * @param request - Provisioning request
   * @returns Provisioning result
   */
  async provisionIdentity(request: ProvisioningRequest): Promise<ProvisioningResult> {
    const errors: string[] = [];
    let binding: IdentityBinding | null = null;
    let actorDocument: Record<string, any> = {};
    let webIdDocument: Record<string, any> = {};
    let aliases: Array<{ type: string; uri: string; verified: boolean }> = [];
    let rdfTriples: Array<{ subject: string; predicate: string; object: string }> = [];

    try {
      // Step 1: Generate URIs
      const webId = `https://${request.podDomain}/${request.username}/profile/card#me`;
      const actorUri = `https://${request.podDomain}/${request.username}`;

      // Step 2: Create identity binding
      try {
        binding = await this.identityService.createIdentityBinding({
          canonicalAccountId: request.canonicalAccountId,
          contextId: request.contextId,
          webId,
          activityPubActorUri: actorUri,
        });
      } catch (error) {
        errors.push(`Failed to create identity binding: ${error instanceof Error ? error.message : String(error)}`);
        return {
          binding: null as any,
          actorDocument: {},
          webIdDocument: {},
          aliases: [],
          rdfTriples: [],
          status: 'failed',
          errors,
        };
      }

      // Step 3: Provision ATProto identity
      try {
        binding = await this.identityService.provisionAtprotoIdentity({
          canonicalAccountId: request.canonicalAccountId,
          atprotoHandle: request.atprotoHandle,
          canonicalDidMethod: request.canonicalDidMethod,
          atprotoPdsEndpoint: request.atprotoPdsEndpoint,
        });
      } catch (error) {
        errors.push(`Failed to provision ATProto identity: ${error instanceof Error ? error.message : String(error)}`);
        // Continue - ATProto is optional
      }

      // Step 4: Generate ActivityPub actor document
      try {
        actorDocument = this.generateActorDocument(binding, request);

        // Add alias projections
        const projections = this.aliasService.generateAliasProjections(binding);
        actorDocument = this.aliasService.updateActorAlsoKnownAs(actorDocument, projections);
        aliases = projections.map((p) => ({
          type: p.type,
          uri: p.uri,
          verified: p.verified,
        }));
      } catch (error) {
        errors.push(`Failed to generate actor document: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Step 5: Generate WebID document
      try {
        webIdDocument = this.generateWebIdDocument(binding, request);

        // Add identity linking
        webIdDocument = this.webIdService.updateWebIdDocument(webIdDocument, binding);

        // Extract RDF triples
        const triples = this.webIdService.generateIdentityTriples(binding);
        rdfTriples = triples.map((t) => ({
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
        }));
      } catch (error) {
        errors.push(`Failed to generate WebID document: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Step 6: Verify bidirectional links
      try {
        const webIdLinks = this.webIdService.extractIdentityLinks(webIdDocument);
        const actorLinks = this.aliasService.extractAliasesFromActor(actorDocument);

        const verified = this.webIdService.verifyBidirectionalLinks(webIdLinks, actorLinks);
        if (!verified) {
          errors.push('Bidirectional link verification failed');
        }
      } catch (error) {
        errors.push(`Failed to verify bidirectional links: ${error instanceof Error ? error.message : String(error)}`);
      }

      return {
        binding,
        actorDocument,
        webIdDocument,
        aliases,
        rdfTriples,
        status: errors.length === 0 ? 'success' : errors.length < 3 ? 'partial' : 'failed',
        errors,
      };
    } catch (error) {
      errors.push(`Unexpected error during provisioning: ${error instanceof Error ? error.message : String(error)}`);
      return {
        binding: null as any,
        actorDocument: {},
        webIdDocument: {},
        aliases: [],
        rdfTriples: [],
        status: 'failed',
        errors,
      };
    }
  }

  /**
   * Generate ActivityPub actor document
   *
   * @param binding - The identity binding
   * @param request - The provisioning request
   * @returns Actor document
   */
  private generateActorDocument(
    binding: IdentityBinding,
    request: ProvisioningRequest
  ): Record<string, any> {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1',
      ],
      type: 'Person',
      id: binding.activityPubActorUri,
      name: request.displayName || request.username,
      preferredUsername: request.username,
      summary: request.summary || '',
      inbox: `${binding.activityPubActorUri}/inbox`,
      outbox: `${binding.activityPubActorUri}/outbox`,
      followers: `${binding.activityPubActorUri}/followers`,
      following: `${binding.activityPubActorUri}/following`,
      liked: `${binding.activityPubActorUri}/liked`,
      publicKey: {
        id: `${binding.activityPubActorUri}#main-key`,
        owner: binding.activityPubActorUri,
        publicKeyPem: '', // Will be filled by signing service
      },
      ...(request.avatar && { icon: { type: 'Image', url: request.avatar } }),
    };
  }

  /**
   * Generate WebID document
   *
   * @param binding - The identity binding
   * @param request - The provisioning request
   * @returns WebID document
   */
  private generateWebIdDocument(
    binding: IdentityBinding,
    request: ProvisioningRequest
  ): Record<string, any> {
    return {
      '@context': {
        '@vocab': 'http://xmlns.com/foaf/0.1/',
        '@language': 'en',
        schema: 'http://schema.org/',
        solid: 'http://www.w3.org/ns/solid/terms#',
        vcard: 'http://www.w3.org/2006/vcard/ns#',
      },
      '@id': binding.webId,
      '@type': 'Person',
      name: request.displayName || request.username,
      givenName: request.username,
      mbox: `mailto:${request.username}@${request.podDomain}`,
      ...(request.avatar && { depiction: request.avatar }),
      ...(request.summary && { 'schema:description': request.summary }),
    };
  }

  /**
   * Get provisioning status
   *
   * @param canonicalAccountId - The account ID
   * @returns Current provisioning status
   */
  async getProvisioningStatus(canonicalAccountId: string): Promise<{
    bound: boolean;
    apProvisioned: boolean;
    atProvisioned: boolean;
    aliasesGenerated: boolean;
    linksVerified: boolean;
  }> {
    const binding = await this.identityService.getIdentityBinding(canonicalAccountId);

    if (!binding) {
      return {
        bound: false,
        apProvisioned: false,
        atProvisioned: false,
        aliasesGenerated: false,
        linksVerified: false,
      };
    }

    return {
      bound: true,
      apProvisioned: !!binding.activityPubActorUri,
      atProvisioned: !!binding.atprotoDid && !!binding.atprotoHandle,
      aliasesGenerated: binding.accountLinks.apAlsoKnownAs.length > 0,
      linksVerified: binding.status === 'active',
    };
  }
}
