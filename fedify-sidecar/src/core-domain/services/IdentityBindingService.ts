/**
 * V6.5 Identity Binding Service - Business Logic for Identity Operations
 *
 * This service orchestrates identity binding operations across:
 * - Repository persistence
 * - Event publishing
 * - Signing contract fulfillment
 * - Validation and error handling
 *
 * The service is the primary interface for identity management.
 */

import { IdentityBinding, IdentityBindingValidation } from '../identity/IdentityBinding.js';
import { IdentityBindingRepository, RepositoryError } from '../identity/IdentityBindingRepository.js';
import {
  SigningService,
  GenerateApSigningKeyRequest,
  GenerateAtSigningKeyRequest,
  SigningError,
} from '../contracts/SigningContracts.js';
import {
  EventPublisher,
  CoreIdentityProvisionedV1,
  CoreIdentityUpdatedV1,
  CoreAccountLinkVerifiedV1,
} from '../events/CoreIdentityEvents.js';

/**
 * Error codes for identity binding service
 */
export enum IdentityBindingServiceErrorCode {
  /**
   * Identity binding not found
   */
  BINDING_NOT_FOUND = 'BINDING_NOT_FOUND',

  /**
   * Account already exists with different identity
   */
  ACCOUNT_ALREADY_EXISTS = 'ACCOUNT_ALREADY_EXISTS',

  /**
   * DID already bound to another account
   */
  DID_ALREADY_BOUND = 'DID_ALREADY_BOUND',

  /**
   * Handle already bound to another account
   */
  HANDLE_ALREADY_BOUND = 'HANDLE_ALREADY_BOUND',

  /**
   * Actor URI already bound to another account
   */
  ACTOR_URI_ALREADY_BOUND = 'ACTOR_URI_ALREADY_BOUND',

  /**
   * Validation failed
   */
  VALIDATION_FAILED = 'VALIDATION_FAILED',

  /**
   * Key generation failed
   */
  KEY_GENERATION_FAILED = 'KEY_GENERATION_FAILED',

  /**
   * Repository error
   */
  REPOSITORY_ERROR = 'REPOSITORY_ERROR',

  /**
   * Event publishing failed
   */
  EVENT_PUBLISHING_FAILED = 'EVENT_PUBLISHING_FAILED',

  /**
   * Invalid state transition
   */
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',

  /**
   * Conflict detected
   */
  CONFLICT = 'CONFLICT',
}

/**
 * Identity binding service error
 */
export class IdentityBindingServiceError extends Error {
  constructor(
    public code: IdentityBindingServiceErrorCode,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'IdentityBindingServiceError';
  }
}

/**
 * Request to create a new identity binding
 */
export interface CreateIdentityBindingRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * Pod/context ID
   */
  contextId: string;

  /**
   * WebID (Solid identifier)
   */
  webId: string;

  /**
   * ActivityPub actor URI
   */
  activityPubActorUri: string;

  /**
   * Optional: Pre-generated AP signing key reference
   */
  apSigningKeyRef?: string;
}

/**
 * Request to provision ATProto identity
 */
export interface ProvisionAtprotoIdentityRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * ATProto DID (may be null for new provisioning)
   */
  atprotoDid?: string | null;

  /**
   * ATProto handle
   */
  atprotoHandle: string;

  /**
   * Canonical DID method
   */
  canonicalDidMethod: 'did:plc' | 'did:web';

  /**
   * ATProto Personal Data Server endpoint
   */
  atprotoPdsEndpoint: string;
}

/**
 * Identity Binding Service
 *
 * Provides high-level operations for identity binding management.
 */
export class IdentityBindingService {
  constructor(
    private repository: IdentityBindingRepository,
    private signingService: SigningService,
    private eventPublisher: EventPublisher
  ) {}

  /**
   * Create a new identity binding
   *
   * @param request - Creation request
   * @returns The created binding
   * @throws IdentityBindingServiceError on failure
   */
  async createIdentityBinding(
    request: CreateIdentityBindingRequest
  ): Promise<IdentityBinding> {
    // Check for duplicates
    const existingByAccountId = await this.repository.getByCanonicalAccountId(
      request.canonicalAccountId
    );
    if (existingByAccountId) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.ACCOUNT_ALREADY_EXISTS,
        `Account ${request.canonicalAccountId} already exists`
      );
    }

    const existingByActorUri = await this.repository.getByActivityPubActorUri(
      request.activityPubActorUri
    );
    if (existingByActorUri) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.ACTOR_URI_ALREADY_BOUND,
        `Actor URI ${request.activityPubActorUri} is already bound`
      );
    }

    const existingByWebId = await this.repository.getByWebId(request.webId);
    if (existingByWebId) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.ACTOR_URI_ALREADY_BOUND,
        `WebID ${request.webId} is already bound`
      );
    }

    // Generate AP signing key if not provided
    let apSigningKeyRef = request.apSigningKeyRef;
    if (!apSigningKeyRef) {
      try {
        const keyResponse = await this.signingService.generateApSigningKey({
          canonicalAccountId: request.canonicalAccountId,
        });
        apSigningKeyRef = keyResponse.keyRef;
      } catch (error) {
        if (error instanceof SigningError) {
          throw new IdentityBindingServiceError(
            IdentityBindingServiceErrorCode.KEY_GENERATION_FAILED,
            `Failed to generate AP signing key: ${error.message}`,
            { originalError: error.code }
          );
        }
        throw error;
      }
    }

    // Create binding
    const now = new Date().toISOString();
    const binding: IdentityBinding = {
      canonicalAccountId: request.canonicalAccountId,
      contextId: request.contextId,
      webId: request.webId,
      activityPubActorUri: request.activityPubActorUri,
      atprotoDid: null,
      atprotoHandle: null,
      canonicalDidMethod: null,
      atprotoPdsEndpoint: null,
      apSigningKeyRef,
      atSigningKeyRef: null,
      atRotationKeyRef: null,
      plc: null,
      didWeb: null,
      accountLinks: {
        apAlsoKnownAs: [],
        atAlsoKnownAs: [],
        relMe: [],
        webIdSameAs: [],
        webIdAccounts: [],
      },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    // Validate
    const validation = IdentityBindingValidation.validate(binding);
    if (!validation.valid) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.VALIDATION_FAILED,
        `Binding validation failed: ${validation.errors.join(', ')}`
      );
    }

    // Persist
    try {
      await this.repository.create(binding);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.REPOSITORY_ERROR,
          `Failed to persist binding: ${error.message}`,
          { originalError: error.code }
        );
      }
      throw error;
    }

    // Publish event
    try {
      const event: CoreIdentityProvisionedV1 = {
        version: 1,
        canonicalAccountId: binding.canonicalAccountId,
        contextId: binding.contextId,
        webId: binding.webId,
        activityPubActorUri: binding.activityPubActorUri,
        atprotoDid: binding.atprotoDid,
        atprotoHandle: binding.atprotoHandle,
        canonicalDidMethod: binding.canonicalDidMethod,
        status: binding.status,
        emittedAt: now,
      };

      await this.eventPublisher.publish(
        'core.identity.provisioned.v1',
        event,
        {
          partitionKey: binding.canonicalAccountId,
          source: 'identity-binding-service',
        }
      );
    } catch (error) {
      // Log but don't fail - binding is already persisted
      console.error('Failed to publish identity provisioned event:', error);
    }

    return binding;
  }

  /**
   * Get identity binding by canonical account ID
   *
   * @param canonicalAccountId - The account ID
   * @returns The binding, or null if not found
   * @throws IdentityBindingServiceError on repository error
   */
  async getIdentityBinding(canonicalAccountId: string): Promise<IdentityBinding | null> {
    try {
      return await this.repository.getByCanonicalAccountId(canonicalAccountId);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.REPOSITORY_ERROR,
          `Failed to retrieve binding: ${error.message}`,
          { originalError: error.code }
        );
      }
      throw error;
    }
  }

  /**
   * Get identity binding by ATProto DID
   *
   * @param did - The DID
   * @returns The binding, or null if not found
   * @throws IdentityBindingServiceError on repository error
   */
  async getIdentityBindingByDid(did: string): Promise<IdentityBinding | null> {
    try {
      return await this.repository.getByAtprotoDid(did);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.REPOSITORY_ERROR,
          `Failed to retrieve binding by DID: ${error.message}`,
          { originalError: error.code }
        );
      }
      throw error;
    }
  }

  /**
   * Get identity binding by ATProto handle
   *
   * @param handle - The handle
   * @returns The binding, or null if not found
   * @throws IdentityBindingServiceError on repository error
   */
  async getIdentityBindingByHandle(handle: string): Promise<IdentityBinding | null> {
    try {
      return await this.repository.getByAtprotoHandle(handle);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.REPOSITORY_ERROR,
          `Failed to retrieve binding by handle: ${error.message}`,
          { originalError: error.code }
        );
      }
      throw error;
    }
  }

  /**
   * Provision ATProto identity for an existing binding
   *
   * @param request - Provisioning request
   * @returns Updated binding
   * @throws IdentityBindingServiceError on failure
   */
  async provisionAtprotoIdentity(
    request: ProvisionAtprotoIdentityRequest
  ): Promise<IdentityBinding> {
    // Get existing binding
    const binding = await this.getIdentityBinding(request.canonicalAccountId);
    if (!binding) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.BINDING_NOT_FOUND,
        `Binding not found for account ${request.canonicalAccountId}`
      );
    }

    // Check if already provisioned
    if (binding.atprotoDid && binding.canonicalDidMethod) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.INVALID_STATE_TRANSITION,
        `ATProto identity already provisioned for account ${request.canonicalAccountId}`
      );
    }

    // Check for duplicate handle
    if (request.atprotoHandle) {
      const existingByHandle = await this.repository.getByAtprotoHandle(
        request.atprotoHandle
      );
      if (existingByHandle && existingByHandle.canonicalAccountId !== request.canonicalAccountId) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.HANDLE_ALREADY_BOUND,
          `Handle ${request.atprotoHandle} is already bound to another account`
        );
      }
    }

    // Generate signing keys
    try {
      const commitKeyResponse = await this.signingService.generateAtSigningKey({
        canonicalAccountId: request.canonicalAccountId,
        purpose: 'commit',
        algorithm: 'k256',
      });

      const rotationKeyResponse = await this.signingService.generateAtSigningKey({
        canonicalAccountId: request.canonicalAccountId,
        purpose: 'rotation',
        algorithm: 'k256',
      });

      // Update binding
      const now = new Date().toISOString();
      binding.atprotoDid = request.atprotoDid || null;
      binding.atprotoHandle = request.atprotoHandle;
      binding.canonicalDidMethod = request.canonicalDidMethod;
      binding.atprotoPdsEndpoint = request.atprotoPdsEndpoint;
      binding.atSigningKeyRef = commitKeyResponse.keyRef;
      binding.atRotationKeyRef = rotationKeyResponse.keyRef;
      binding.updatedAt = now;

      // Initialize DID method-specific state
      if (request.canonicalDidMethod === 'did:plc') {
        binding.plc = {
          opCid: null,
          rotationKeyRef: rotationKeyResponse.keyRef,
          plcUpdateState: null,
          lastSubmittedAt: null,
          lastConfirmedAt: null,
          lastError: null,
        };
      } else if (request.canonicalDidMethod === 'did:web') {
        binding.didWeb = {
          hostname: new URL(request.atprotoPdsEndpoint).hostname,
          documentPath: '/.well-known/did.json',
          lastRenderedAt: null,
        };
      }

      // Validate
      const validation = IdentityBindingValidation.validate(binding);
      if (!validation.valid) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.VALIDATION_FAILED,
          `Updated binding validation failed: ${validation.errors.join(', ')}`
        );
      }

      // Persist
      await this.repository.update(binding);

      // Publish event
      const event: CoreIdentityUpdatedV1 = {
        version: 1,
        canonicalAccountId: binding.canonicalAccountId,
        contextId: binding.contextId,
        webId: binding.webId,
        activityPubActorUri: binding.activityPubActorUri,
        atprotoDid: binding.atprotoDid,
        atprotoHandle: binding.atprotoHandle,
        canonicalDidMethod: binding.canonicalDidMethod,
        status: binding.status,
        emittedAt: now,
        reason: 'atproto_provisioned',
      };

      await this.eventPublisher.publish(
        'core.identity.updated.v1',
        event,
        {
          partitionKey: binding.canonicalAccountId,
          source: 'identity-binding-service',
        }
      );

      return binding;
    } catch (error) {
      if (error instanceof SigningError) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.KEY_GENERATION_FAILED,
          `Failed to generate ATProto signing keys: ${error.message}`,
          { originalError: error.code }
        );
      }
      if (error instanceof IdentityBindingServiceError) {
        throw error;
      }
      throw error;
    }
  }

  /**
   * Update account link verification status
   *
   * @param canonicalAccountId - The account ID
   * @param status - Verification status
   * @param ttlSeconds - TTL for verification
   * @throws IdentityBindingServiceError on failure
   */
  async updateAccountLinkVerification(
    canonicalAccountId: string,
    status: 'fresh_verified' | 'stale_verified',
    ttlSeconds?: number
  ): Promise<void> {
    const binding = await this.getIdentityBinding(canonicalAccountId);
    if (!binding) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.BINDING_NOT_FOUND,
        `Binding not found for account ${canonicalAccountId}`
      );
    }

    const now = new Date().toISOString();
    const event: CoreAccountLinkVerifiedV1 = {
      version: 1,
      canonicalAccountId,
      status,
      verifiedAt: now,
      details: {
        apLinkedToAt: true,
        atLinkedToAp: true,
        webLinkedToAp: true,
        webLinkedToAt: true,
        handleValidated: true,
      },
      ttlSeconds,
    };

    try {
      await this.eventPublisher.publish(
        'core.accountlink.verified.v1',
        event,
        {
          partitionKey: canonicalAccountId,
          source: 'identity-binding-service',
        }
      );
    } catch (error) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.EVENT_PUBLISHING_FAILED,
        `Failed to publish account link verification event: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Suspend an account
   *
   * @param canonicalAccountId - The account ID
   * @throws IdentityBindingServiceError on failure
   */
  async suspendAccount(canonicalAccountId: string): Promise<void> {
    const binding = await this.getIdentityBinding(canonicalAccountId);
    if (!binding) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.BINDING_NOT_FOUND,
        `Binding not found for account ${canonicalAccountId}`
      );
    }

    binding.status = 'suspended';
    binding.updatedAt = new Date().toISOString();

    try {
      await this.repository.update(binding);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.REPOSITORY_ERROR,
          `Failed to suspend account: ${error.message}`,
          { originalError: error.code }
        );
      }
      throw error;
    }
  }

  /**
   * Reactivate a suspended account
   *
   * @param canonicalAccountId - The account ID
   * @throws IdentityBindingServiceError on failure
   */
  async reactivateAccount(canonicalAccountId: string): Promise<void> {
    const binding = await this.getIdentityBinding(canonicalAccountId);
    if (!binding) {
      throw new IdentityBindingServiceError(
        IdentityBindingServiceErrorCode.BINDING_NOT_FOUND,
        `Binding not found for account ${canonicalAccountId}`
      );
    }

    binding.status = 'active';
    binding.updatedAt = new Date().toISOString();

    try {
      await this.repository.update(binding);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new IdentityBindingServiceError(
          IdentityBindingServiceErrorCode.REPOSITORY_ERROR,
          `Failed to reactivate account: ${error.message}`,
          { originalError: error.code }
        );
      }
      throw error;
    }
  }
}
