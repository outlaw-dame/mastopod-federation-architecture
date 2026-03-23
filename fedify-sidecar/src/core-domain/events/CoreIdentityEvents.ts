/**
 * V6.5 Core Identity Events - Event Definitions for Identity Lifecycle
 *
 * These events are emitted to RedPanda topics and represent key lifecycle
 * events in the dual-protocol identity system.
 *
 * Topic mapping:
 * - CoreIdentityProvisionedV1 -> core.identity.provisioned.v1
 * - CoreIdentityUpdatedV1 -> core.identity.updated.v1
 * - CoreAccountLinkVerifiedV1 -> core.accountlink.verified.v1
 * - CoreAccountLinkInvalidatedV1 -> core.accountlink.invalidated.v1
 */

import { CanonicalDidMethod } from '../identity/IdentityBinding.js';

/**
 * Event: Core Identity Provisioned
 *
 * Emitted when a new dual-protocol identity is provisioned.
 * This marks the successful creation of a canonical account with both
 * ActivityPub and ATProto identities.
 *
 * Topic: core.identity.provisioned.v1
 */
export interface CoreIdentityProvisionedV1 {
  /**
   * Event version
   */
  version: 1;

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
   * ATProto DID (may be null if not yet provisioned)
   */
  atprotoDid: string | null;

  /**
   * ATProto handle (may be null if not yet provisioned)
   */
  atprotoHandle: string | null;

  /**
   * Canonical DID method (may be null if not yet provisioned)
   */
  canonicalDidMethod: CanonicalDidMethod | null;

  /**
   * Account status
   */
  status: 'active' | 'suspended' | 'deactivated';

  /**
   * ISO 8601 timestamp of event emission
   */
  emittedAt: string;
}

/**
 * Event: Core Identity Updated
 *
 * Emitted when an existing dual-protocol identity is updated.
 * This can include handle changes, key rotations, or status changes.
 *
 * Topic: core.identity.updated.v1
 */
export interface CoreIdentityUpdatedV1 extends CoreIdentityProvisionedV1 {
  /**
   * Previous status (for tracking transitions)
   */
  previousStatus?: 'active' | 'suspended' | 'deactivated';

  /**
   * Update reason
   */
  reason?: string;
}

/**
 * Event: Account Link Verified
 *
 * Emitted when bidirectional account links between ActivityPub and ATProto
 * are successfully verified.
 *
 * Topic: core.accountlink.verified.v1
 */
export interface CoreAccountLinkVerifiedV1 {
  /**
   * Event version
   */
  version: 1;

  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * Verification status
   */
  status: 'fresh_verified' | 'stale_verified';

  /**
   * ISO 8601 timestamp of verification
   */
  verifiedAt: string;

  /**
   * Details of what was verified
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
   * TTL for this verification (in seconds)
   */
  ttlSeconds?: number;
}

/**
 * Event: Account Link Invalidated
 *
 * Emitted when account links are invalidated due to conflicts,
 * failed validation, or other issues.
 *
 * Topic: core.accountlink.invalidated.v1
 */
export interface CoreAccountLinkInvalidatedV1 {
  /**
   * Event version
   */
  version: 1;

  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * ISO 8601 timestamp of invalidation
   */
  invalidatedAt: string;

  /**
   * Reason for invalidation
   */
  reason:
    | 'conflict'                    // Conflicting claims detected
    | 'handle_validation_failed'    // Handle validation failed
    | 'projection_mismatch'         // Account link projection mismatch
    | 'remote_fetch_error'          // Error fetching remote identity
    | 'manual_revocation'           // Manually revoked by user
    | 'ttl_expired';                // Verification TTL expired

  /**
   * Details about the invalidation
   */
  details?: {
    /**
     * Conflicting identity if reason is 'conflict'
     */
    conflictingIdentity?: string;

    /**
     * Error message if reason is 'remote_fetch_error'
     */
    errorMessage?: string;

    /**
     * Which links were affected
     */
    affectedLinks?: string[];
  };
}

/**
 * Event: ATProto Identity Created
 *
 * Emitted when an ATProto identity (DID + handle) is successfully created.
 *
 * Topic: at.identity.v1
 */
export interface AtIdentityV1 {
  /**
   * Event version
   */
  version: 1;

  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * ATProto DID
   */
  did: string;

  /**
   * ATProto handle
   */
  handle: string;

  /**
   * Canonical DID method
   */
  canonicalDidMethod: CanonicalDidMethod;

  /**
   * Personal Data Server endpoint
   */
  pdsEndpoint: string;

  /**
   * ISO 8601 timestamp of event emission
   */
  emittedAt: string;
}

/**
 * Event: ATProto Account Status Changed
 *
 * Emitted when an ATProto account status changes.
 *
 * Topic: at.account.v1
 */
export interface AtAccountV1 {
  /**
   * Event version
   */
  version: 1;

  /**
   * Canonical account ID
   */
  canonicalAccountId: string;

  /**
   * ATProto DID
   */
  did: string;

  /**
   * Account status
   */
  status: 'active' | 'suspended' | 'deactivated';

  /**
   * ISO 8601 timestamp of event emission
   */
  emittedAt: string;
}

/**
 * Union type for all core identity events
 */
export type CoreIdentityEvent =
  | CoreIdentityProvisionedV1
  | CoreIdentityUpdatedV1
  | CoreAccountLinkVerifiedV1
  | CoreAccountLinkInvalidatedV1
  | AtIdentityV1
  | AtAccountV1;

/**
 * Event metadata
 */
export interface EventMetadata {
  /**
   * Unique event ID
   */
  eventId: string;

  /**
   * Topic name
   */
  topic: string;

  /**
   * Partition key (usually canonical account ID)
   */
  partitionKey: string;

  /**
   * ISO 8601 timestamp of emission
   */
  emittedAt: string;

  /**
   * Source system
   */
  source: string;

  /**
   * Trace ID for distributed tracing
   */
  traceId?: string;

  /**
   * Span ID for distributed tracing
   */
  spanId?: string;

  /**
   * Correlation ID for related events
   */
  correlationId?: string;
}

/**
 * Event with metadata
 */
export interface EventEnvelope<T extends CoreIdentityEvent> {
  /**
   * Event metadata
   */
  metadata: EventMetadata;

  /**
   * Event payload
   */
  payload: T;
}

/**
 * Event publisher interface
 */
export interface EventPublisher {
  /**
   * Publish an event
   */
  publish<T extends CoreIdentityEvent>(
    topic: string,
    event: T,
    metadata?: Partial<EventMetadata>
  ): Promise<void>;

  /**
   * Publish multiple events atomically
   */
  publishBatch(
    events: Array<{
      topic: string;
      event: CoreIdentityEvent;
      metadata?: Partial<EventMetadata>;
    }>
  ): Promise<void>;
}

/**
 * Event subscriber interface
 */
export interface EventSubscriber {
  /**
   * Subscribe to events on a topic
   */
  subscribe<T extends CoreIdentityEvent>(
    topic: string,
    handler: (event: EventEnvelope<T>) => Promise<void>
  ): Promise<void>;

  /**
   * Unsubscribe from a topic
   */
  unsubscribe(topic: string): Promise<void>;
}
