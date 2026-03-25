/**
 * V6.5 DID Document Renderer - DID Document Generation
 *
 * Renders DID documents for both did:plc and did:web methods.
 * DID documents are the authoritative source for public keys and service endpoints.
 *
 * Follows W3C DID Core specification and ATProto conventions.
 */

import { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';

/**
 * DID document
 */
export interface DidDocument {
  /**
   * Context
   */
  '@context':
    | string
    | string[]
    | Record<string, any>
    | Array<string | Record<string, any>>;

  /**
   * DID identifier
   */
  id: string;

  /**
   * Verification methods (public keys)
   */
  verificationMethod?: VerificationMethod[];

  /**
   * Authentication methods
   */
  authentication?: string[];

  /**
   * Assertion methods
   */
  assertionMethod?: string[];

  /**
   * Service endpoints
   */
  service?: ServiceEndpoint[];

  /**
   * Also known as (aliases)
   */
  alsoKnownAs?: string[];
}

/**
 * Verification method (public key)
 */
export interface VerificationMethod {
  /**
   * Method ID
   */
  id: string;

  /**
   * Method type
   */
  type: string;

  /**
   * Controller DID
   */
  controller: string;

  /**
   * Public key in multibase format
   */
  publicKeyMultibase?: string;

  /**
   * Public key in PEM format
   */
  publicKeyPem?: string;
}

/**
 * Service endpoint
 */
export interface ServiceEndpoint {
  /**
   * Service ID
   */
  id: string;

  /**
   * Service type
   */
  type: string | string[];

  /**
   * Service endpoint URL
   */
  serviceEndpoint: string | Record<string, string>;
}

/**
 * DID Document Renderer
 *
 * Generates DID documents for different DID methods.
 */
export class DidDocumentRenderer {
  /**
   * Render DID document for did:plc
   *
   * @param binding - The identity binding
   * @param signingPublicKey - The signing key in multibase format
   * @param rotationPublicKey - The rotation key in multibase format
   * @returns DID document
   */
  renderPlcDidDocument(
    binding: IdentityBinding,
    signingPublicKey: string,
    rotationPublicKey: string
  ): DidDocument {
    if (!binding.atprotoDid) {
      throw new Error('ATProto DID not provisioned');
    }

    const did = binding.atprotoDid;

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/secp256k1-2019/v1',
      ],
      id: did,
      verificationMethod: [
        {
          id: `${did}#signing-key`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: did,
          publicKeyMultibase: signingPublicKey,
        },
        {
          id: `${did}#rotation-key`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: did,
          publicKeyMultibase: rotationPublicKey,
        },
      ],
      authentication: [`${did}#signing-key`],
      assertionMethod: [`${did}#signing-key`],
      service: this.generateServiceEndpoints(binding, did),
      alsoKnownAs: this.generateAlsoKnownAs(binding),
    };
  }

  /**
   * Render DID document for did:web
   *
   * @param binding - The identity binding
   * @param signingPublicKey - The signing key in PEM format
   * @returns DID document
   */
  renderWebDidDocument(
    binding: IdentityBinding,
    signingPublicKey: string
  ): DidDocument {
    if (!binding.didWeb) {
      throw new Error('did:web state not initialized');
    }

    const hostname = binding.didWeb.hostname;
    if (!hostname) {
      throw new Error('did:web hostname not configured');
    }

    const did = `did:web:${hostname}`;

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/rsa-2018/v1',
      ],
      id: did,
      verificationMethod: [
        {
          id: `${did}#key-1`,
          type: 'RsaVerificationKey2018',
          controller: did,
          publicKeyPem: signingPublicKey,
        },
      ],
      authentication: [`${did}#key-1`],
      assertionMethod: [`${did}#key-1`],
      service: this.generateServiceEndpoints(binding, did),
      alsoKnownAs: this.generateAlsoKnownAs(binding),
    };
  }

  /**
   * Generate service endpoints
   *
   * @param binding - The identity binding
   * @param did - DID being rendered for the document
   * @returns Service endpoints
   */
  private generateServiceEndpoints(
    binding: IdentityBinding,
    did: string
  ): ServiceEndpoint[] {
    const endpoints: ServiceEndpoint[] = [];

    if (binding.atprotoPdsEndpoint && binding.atprotoDid) {
      endpoints.push({
        id: `${binding.atprotoDid}#pds`,
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: binding.atprotoPdsEndpoint,
      });
    }

    endpoints.push({
      id: `${did}#ap-inbox`,
      type: 'ActivityPubInbox',
      serviceEndpoint: `${binding.activityPubActorUri}/inbox`,
    });

    endpoints.push({
      id: `${did}#ap-outbox`,
      type: 'ActivityPubOutbox',
      serviceEndpoint: `${binding.activityPubActorUri}/outbox`,
    });

    endpoints.push({
      id: `${did}#webid`,
      type: 'WebID',
      serviceEndpoint: binding.webId,
    });

    return endpoints;
  }

  /**
   * Generate alsoKnownAs list
   *
   * @param binding - The identity binding
   * @returns Array of aliases
   */
  private generateAlsoKnownAs(binding: IdentityBinding): string[] {
    const aliases: string[] = [];

    aliases.push(binding.activityPubActorUri);
    aliases.push(binding.webId);

    if (binding.atprotoHandle) {
      aliases.push(`at://${binding.atprotoHandle}`);
    }

    aliases.push(...binding.accountLinks.atAlsoKnownAs);

    return aliases;
  }

  /**
   * Render DID document as JSON
   *
   * @param doc - The DID document
   * @returns JSON string
   */
  toJson(doc: DidDocument): string {
    return JSON.stringify(doc, null, 2);
  }

  /**
   * Render DID document as JSON-LD
   *
   * @param doc - The DID document
   * @returns JSON-LD string
   */
  toJsonLd(doc: DidDocument): string {
    return JSON.stringify(doc, null, 2);
  }

  /**
   * Validate DID document
   *
   * @param doc - The DID document
   * @returns Validation result
   */
  validate(doc: DidDocument): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!doc.id) {
      errors.push('Missing required field: id');
    }

    if (!doc['@context']) {
      errors.push('Missing required field: @context');
    }

    if (!doc.verificationMethod || doc.verificationMethod.length === 0) {
      errors.push('Must have at least one verification method');
    } else {
      for (const method of doc.verificationMethod) {
        if (!method.id || !method.type || !method.controller) {
          errors.push('Verification method missing required fields');
        }
      }
    }

    if (!doc.authentication || doc.authentication.length === 0) {
      errors.push('Must have at least one authentication method');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
