/**
 * V6.5 Signing Contracts - Protocol-Specific Key and Signature Interfaces
 *
 * Defines the contracts for:
 * - ActivityPub HTTP signature generation
 * - ATProto commit signing
 * - ATProto DID update (PLC) signing
 * - Public key retrieval and management
 */

/**
 * Phase 1 scaffolding for Fedify runtime integration.
 *
 * This adapter is intentionally narrow and side-effect free by default.
 * Implementations can emit metrics/traces or delegate to Fedify framework
 * primitives when ENABLE_FEDIFY_RUNTIME_INTEGRATION=true.
 */
export interface FederationRuntimeAdapter {
  readonly name: string;
  readonly enabled: boolean;
  onInboundVerified?(input: {
    actorUri: string;
    activityId?: string;
    activityType?: string;
    isPublic?: boolean;
  }): Promise<void> | void;
  onOutboundDelivered?(input: {
    actorUri: string;
    activityId: string;
    targetDomain: string;
    statusCode?: number;
  }): Promise<void> | void;
}

export const NoopFederationRuntimeAdapter: FederationRuntimeAdapter = {
  name: "noop",
  enabled: false,
};

/**
 * Request to generate a new ActivityPub signing key
 */
export interface GenerateApSigningKeyRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;
}

/**
 * Request to generate a new ATProto signing key
 */
export interface GenerateAtSigningKeyRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * Purpose of the key
   * - 'commit': Used for signing repository commits
   * - 'rotation': Used for signing DID update operations
   */
  purpose: 'commit' | 'rotation';

  /**
   * Cryptographic algorithm
   * Currently only 'k256' (secp256k1) is supported
   */
  algorithm: 'k256';
}

/**
 * Response from key generation
 */
export interface GenerateKeyResponse {
  /**
   * Key reference for storage
   * Used in IdentityBinding to reference the key
   */
  keyRef: string;

  /**
   * Public key in multibase format (optional)
   * May be included for immediate use
   */
  publicKeyMultibase?: string;

  /**
   * ISO 8601 timestamp of key creation
   */
  createdAt: string;
}

/**
 * Request to sign an ATProto repository commit
 *
 * Commits are signed using the account's signing key and represent
 * mutations to the repository (new records, updates, deletes).
 */
export interface SignAtprotoCommitRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * DID of the repository being committed to
   */
  did: string;

  /**
   * Unsigned commit bytes in base64 format
   * This is the serialized Root node from the MST
   */
  unsignedCommitBytesBase64: string;

  /**
   * Repository revision number
   * Used to prevent replay attacks
   */
  rev: string;
}

/**
 * Response from ATProto commit signing
 */
export interface SignAtprotoCommitResponse {
  /**
   * DID of the repository
   */
  did: string;

  /**
   * Key ID used for signing
   * Format: {did}#{keyName}
   */
  keyId: string;

  /**
   * Signature in base64url format
   * Can be directly used in commit objects
   */
  signatureBase64Url: string;

  /**
   * Algorithm used
   */
  algorithm: 'k256';

  /**
   * ISO 8601 timestamp of signing
   */
  signedAt: string;
}

/**
 * Request to sign a PLC (did:plc) operation
 *
 * PLC operations are signed using the account's rotation key and
 * represent mutations to the DID document (key rotation, handle updates, etc.)
 */
export interface SignPlcOperationRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * DID being updated
   */
  did: string;

  /**
   * Unsigned operation bytes in base64 format
   * This is the serialized operation object
   */
  operationBytesBase64: string;
}

/**
 * Response from PLC operation signing
 */
export interface SignPlcOperationResponse {
  /**
   * DID being updated
   */
  did: string;

  /**
   * Key ID used for signing
   * Must be a rotation key
   */
  keyId: string;

  /**
   * Signature in base64url format
   */
  signatureBase64Url: string;

  /**
   * Algorithm used
   */
  algorithm: 'k256';

  /**
   * ISO 8601 timestamp of signing
   */
  signedAt: string;
}

/**
 * Request to retrieve an ATProto public key
 */
export interface GetAtprotoPublicKeyRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * Purpose of the key
   * - 'commit': Retrieve the commit signing key
   * - 'rotation': Retrieve the rotation key
   */
  purpose: 'commit' | 'rotation';
}

/**
 * Response with ATProto public key
 */
export interface GetAtprotoPublicKeyResponse {
  /**
   * DID of the account (optional if not yet provisioned)
   */
  did?: string;

  /**
   * Key ID
   * Format: {did}#{keyName}
   */
  keyId: string;

  /**
   * Public key in multibase format
   * Can be directly used in DID documents
   */
  publicKeyMultibase: string;

  /**
   * Algorithm
   */
  algorithm: 'k256';
}

/**
 * Request to retrieve an ActivityPub public key
 */
export interface GetApPublicKeyRequest {
  /**
   * Canonical account ID
   */
  canonicalAccountId: string;
}

/**
 * Response with ActivityPub public key
 */
export interface GetApPublicKeyResponse {
  /**
   * ActivityPub actor URI
   */
  actorUri: string;

  /**
   * Key ID for HTTP signatures
   * Format: {actorUri}#main-key
   */
  keyId: string;

  /**
   * Public key in PEM format
   * Used in ActivityPub actor documents
   */
  publicKeyPem: string;

  /**
   * Algorithm
   */
  algorithm: 'RSA-SHA256' | 'RSA-SHA512';
}

/**
 * Signing service interface
 *
 * Implementations handle secure key storage and signing operations.
 * Keys MUST never leave the signing service - only signatures are returned.
 */
export interface SigningService {
  /**
   * Generate a new ActivityPub signing key
   */
  generateApSigningKey(
    request: GenerateApSigningKeyRequest
  ): Promise<GenerateKeyResponse>;

  /**
   * Generate a new ATProto signing key
   */
  generateAtSigningKey(
    request: GenerateAtSigningKeyRequest
  ): Promise<GenerateKeyResponse>;

  /**
   * Sign an ATProto repository commit
   */
  signAtprotoCommit(
    request: SignAtprotoCommitRequest
  ): Promise<SignAtprotoCommitResponse>;

  /**
   * Sign a PLC operation
   */
  signPlcOperation(
    request: SignPlcOperationRequest
  ): Promise<SignPlcOperationResponse>;

  /**
   * Retrieve an ATProto public key
   */
  getAtprotoPublicKey(
    request: GetAtprotoPublicKeyRequest
  ): Promise<GetAtprotoPublicKeyResponse>;

  /**
   * Retrieve an ActivityPub public key
   */
  getApPublicKey(
    request: GetApPublicKeyRequest
  ): Promise<GetApPublicKeyResponse>;
}

/**
 * Error types for signing operations
 */
export enum SigningErrorCode {
  /**
   * Key not found
   */
  KEY_NOT_FOUND = 'KEY_NOT_FOUND',

  /**
   * Invalid key reference
   */
  INVALID_KEY_REF = 'INVALID_KEY_REF',

  /**
   * Signing operation failed
   */
  SIGNING_FAILED = 'SIGNING_FAILED',

  /**
   * Key material corrupted
   */
  KEY_CORRUPTED = 'KEY_CORRUPTED',

  /**
   * HSM/KMS error
   */
  KMS_ERROR = 'KMS_ERROR',

  /**
   * Account not found
   */
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',

  /**
   * Invalid request parameters
   */
  INVALID_REQUEST = 'INVALID_REQUEST',
}

/**
 * Signing error
 */
export class SigningError extends Error {
  constructor(
    public code: SigningErrorCode,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'SigningError';
  }
}
