/**
 * V6.5 Identity Binding - Authoritative Dual-Protocol Identity Model
 *
 * This is the canonical representation of a dual-protocol identity that bridges
 * ActivityPub and ATProto. It serves as the source of truth for all identity-related
 * operations across both protocols.
 *
 * Key Invariants:
 * - atRotationKeyRef must never equal atSigningKeyRef in production policy
 * - plc.rotationKeyRef mirrors atRotationKeyRef
 * - canonicalDidMethod determines which mutation path is used
 */

/**
 * Canonical DID Method - determines identity mutation strategy
 */
export type CanonicalDidMethod = 'did:plc' | 'did:web';

/**
 * PLC Update State Machine - tracks did:plc mutation lifecycle
 *
 * State transitions:
 * - null/CONFIRMED/FAILED/STALE -> PENDING_SUBMISSION (on SUBMIT)
 * - PENDING_SUBMISSION -> SUBMITTED (on SUBMIT)
 * - SUBMITTED -> CONFIRMED (on CONFIRM)
 * - SUBMITTED -> FAILED (on FAIL)
 * - SUBMITTED -> PENDING_SUBMISSION (on TIMEOUT)
 * - SUBMITTED/PENDING_SUBMISSION -> STALE (on MARK_STALE)
 */
export type PlcUpdateState =
  | 'PENDING_SUBMISSION'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'STALE';

/**
 * Core identity binding for a canonical account
 *
 * This structure maintains:
 * 1. Canonical account identity (WebID + AP actor)
 * 2. ATProto identity binding (DID + handle)
 * 3. Protocol-specific signing keys
 * 4. Account link projections (for external discovery)
 * 5. Status and lifecycle tracking
 */
export interface IdentityBinding {
  /**
   * Canonical account identifier
   * Unique within the pod/context
   */
  canonicalAccountId: string;

  /**
   * Pod/context identifier
   * Used for multi-tenancy and isolation
   */
  contextId: string;

  /**
   * WebID (Solid identifier)
   * Format: https://pod.example/username/profile/card#me
   */
  webId: string;

  /**
   * ActivityPub actor URI
   * Format: https://pod.example/username
   */
  activityPubActorUri: string;

  /**
   * ATProto Decentralized Identifier
   * Format: did:plc:xxxxx or did:web:hostname
   * null until provisioned
   */
  atprotoDid: string | null;

  /**
   * ATProto handle (DNS name)
   * Format: username.pod.example
   * null until provisioned
   */
  atprotoHandle: string | null;

  /**
   * Canonical DID method for this account
   * Determines mutation strategy (PLC vs did:web)
   * null until provisioned
   */
  canonicalDidMethod: CanonicalDidMethod | null;

  /**
   * ATProto Personal Data Server endpoint
   * Format: https://pds.example
   * null until provisioned
   */
  atprotoPdsEndpoint: string | null;

  /**
   * ATProto hosting source.
   * - local: this sidecar/backend pair manages the AT identity and repo
   * - external: identity is linked to an external PDS and must not be
   *   treated as locally hosted unless an explicit import/migration occurs
   */
  atprotoSource?: 'local' | 'external';

  /**
   * Whether this deployment manages the ATProto signing and repo lifecycle.
   * External linked accounts must set this to false and fail closed in
   * local-only code paths.
   */
  atprotoManaged?: boolean;

  /**
   * ActivityPub signing key reference
   * Points to the key used for HTTP signatures
   * Always present after provisioning
   */
  apSigningKeyRef: string;

  /**
   * ATProto signing key reference (for commits)
   * Points to the key used for repository commits
   * null until ATProto provisioning
   */
  atSigningKeyRef: string | null;

  /**
   * ATProto rotation key reference
   * Points to the key used for DID updates
   * Must never equal atSigningKeyRef
   * null until ATProto provisioning
   */
  atRotationKeyRef: string | null;

  /**
   * PLC-specific state (only present if canonicalDidMethod === 'did:plc')
   */
  plc: {
    /**
     * Current operation CID from PLC directory
     * Used to track the latest state on PLC
     */
    opCid: string | null;

    /**
     * Rotation key reference for PLC operations
     * Mirrors atRotationKeyRef
     */
    rotationKeyRef: string | null;

    /**
     * Current state in the PLC update state machine
     */
    plcUpdateState: PlcUpdateState | null;

    /**
     * Timestamp of last PLC operation submission
     */
    lastSubmittedAt: string | null;

    /**
     * Timestamp of last confirmed PLC operation
     */
    lastConfirmedAt: string | null;

    /**
     * Last error message from PLC operations
     */
    lastError: string | null;
  } | null;

  /**
   * did:web-specific state (only present if canonicalDidMethod === 'did:web')
   */
  didWeb: {
    /**
     * Hostname for the did:web DID
     * Format: pod.example
     */
    hostname: string | null;

    /**
     * Document path for the did:web DID
     * Format: /.well-known/did.json
     */
    documentPath: string | null;

    /**
     * Timestamp of last DID document render
     */
    lastRenderedAt: string | null;
  } | null;

  /**
   * Account link projections for external discovery
   * These are descriptive and require application-level verification
   */
  accountLinks: {
    /**
     * ActivityPub alsoKnownAs assertions
     * Links to external identities (e.g., at://did:plc:xxx, bsky.app/profile/xxx)
     */
    apAlsoKnownAs: string[];

    /**
     * ATProto alsoKnownAs assertions
     * Links to ActivityPub actor and other protocols
     */
    atAlsoKnownAs: string[];

    /**
     * HTML rel="me" links
     * For bidirectional verification
     */
    relMe: string[];

    /**
     * WebID schema:sameAs links
     * Looser identity-linking property
     */
    webIdSameAs: string[];

    /**
     * WebID foaf:account links
     * Account references in RDF
     */
    webIdAccounts: string[];
  };

  /**
   * Account status
   */
  status: 'active' | 'suspended' | 'deactivated';

  /**
   * ISO 8601 timestamp of binding creation
   */
  createdAt: string;

  /**
   * ISO 8601 timestamp of last binding update
   */
  updatedAt: string;
}

/**
 * Account Link Verification Status
 */
export type AccountLinkVerificationStatus =
  | 'fresh_verified'  // Recently verified, within TTL
  | 'stale_verified'   // Verified but TTL expired
  | 'unverified'       // Not yet verified
  | 'conflict'         // Conflicting claims detected
  | 'error';           // Error during verification

/**
 * Account Link Verification Record
 *
 * Tracks the verification status of bidirectional account links
 * between ActivityPub and ATProto identities.
 */
export interface AccountLinkVerificationRecord {
  /**
   * Subject key for deduplication
   * Format: ap:{actorUri}:at:{did} or web:{webId}:at:{did}
   */
  subjectKey: string;

  /**
   * Current verification status
   */
  status: AccountLinkVerificationStatus;

  /**
   * ISO 8601 timestamp of last verification check
   */
  checkedAt: string;

  /**
   * ISO 8601 timestamp when verification expires
   * Verification is considered stale after this time
   */
  expiresAt: string;

  /**
   * ETag from source document (for caching)
   */
  sourceEtag?: string;

  /**
   * Last-Modified header from source (for caching)
   */
  sourceLastModified?: string;

  /**
   * Verification details
   */
  details: {
    /**
     * AP actor links to AT DID
     */
    apLinkedToAt?: boolean;

    /**
     * AT DID doc links back to AP actor
     */
    atLinkedToAp?: boolean;

    /**
     * WebID links to AP actor
     */
    webLinkedToAp?: boolean;

    /**
     * WebID links to AT DID
     */
    webLinkedToAt?: boolean;

    /**
     * Handle validated via DNS/well-known
     */
    handleValidated?: boolean;
  };

  /**
   * Error message if verification failed
   */
  errorMessage?: string;
}

/**
 * Validation helpers
 */
export const IdentityBindingValidation = {
  /**
   * Validate that rotation and signing keys are different
   */
  validateKeyDistinctness(binding: IdentityBinding): boolean {
    if (!binding.atRotationKeyRef || !binding.atSigningKeyRef) {
      return true; // Not yet provisioned
    }
    return binding.atRotationKeyRef !== binding.atSigningKeyRef;
  },

  /**
   * Validate that PLC rotation key mirrors AT rotation key
   */
  validatePlcKeyMirror(binding: IdentityBinding): boolean {
    if (!binding.plc) {
      return true; // Not a PLC binding
    }
    if (!binding.atRotationKeyRef) {
      return binding.plc.rotationKeyRef === null;
    }
    return binding.plc.rotationKeyRef === binding.atRotationKeyRef;
  },

  /**
   * Validate that DID method is consistent with state
   */
  validateDidMethodConsistency(binding: IdentityBinding): boolean {
    if (!binding.canonicalDidMethod) {
      return binding.plc === null && binding.didWeb === null;
    }
    if (binding.canonicalDidMethod === 'did:plc') {
      return binding.plc !== null && binding.didWeb === null;
    }
    if (binding.canonicalDidMethod === 'did:web') {
      return binding.plc === null && binding.didWeb !== null;
    }
    return false;
  },

  /**
   * Full validation
   */
  validate(binding: IdentityBinding): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.validateKeyDistinctness(binding)) {
      errors.push('AT rotation key must differ from signing key');
    }

    if (!this.validatePlcKeyMirror(binding)) {
      errors.push('PLC rotation key must mirror AT rotation key');
    }

    if (!this.validateDidMethodConsistency(binding)) {
      errors.push('DID method state is inconsistent');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};
