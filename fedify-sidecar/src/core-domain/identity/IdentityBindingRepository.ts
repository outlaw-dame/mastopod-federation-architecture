/**
 * V6.5 Identity Binding Repository - Data Access Interface
 *
 * Defines the contract for persisting and retrieving identity bindings.
 * Implementations can use various backends (Fuseki/SPARQL, PostgreSQL, etc.)
 *
 * This interface is designed to support efficient lookups by all key identifiers:
 * - Canonical account ID (primary key)
 * - ATProto DID
 * - ATProto handle
 * - ActivityPub actor URI
 */

import { IdentityBinding } from './IdentityBinding.js';

/**
 * Repository error codes
 */
export enum RepositoryErrorCode {
  /**
   * Identity binding not found
   */
  NOT_FOUND = 'NOT_FOUND',

  /**
   * Duplicate key constraint violation
   */
  DUPLICATE = 'DUPLICATE',

  /**
   * Validation error
   */
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  /**
   * Persistence error
   */
  PERSISTENCE_ERROR = 'PERSISTENCE_ERROR',

  /**
   * Conflict during update
   */
  CONFLICT = 'CONFLICT',

  /**
   * Query error
   */
  QUERY_ERROR = 'QUERY_ERROR',
}

/**
 * Repository error
 */
export class RepositoryError extends Error {
  constructor(
    public code: RepositoryErrorCode,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/**
 * Identity Binding Repository
 *
 * Provides CRUD operations and efficient lookups for identity bindings.
 */
export interface IdentityBindingRepository {
  /**
   * Retrieve binding by canonical account ID
   *
   * @param canonicalAccountId - The account ID
   * @returns The binding, or null if not found
   * @throws RepositoryError on query failure
   */
  getByCanonicalAccountId(
    canonicalAccountId: string
  ): Promise<IdentityBinding | null>;

  /**
   * Retrieve binding by ATProto DID
   *
   * @param did - The DID (e.g., did:plc:xxx or did:web:xxx)
   * @returns The binding, or null if not found
   * @throws RepositoryError on query failure
   */
  getByAtprotoDid(did: string): Promise<IdentityBinding | null>;

  /**
   * Retrieve binding by ATProto handle
   *
   * @param handle - The handle (e.g., alice.pod.example)
   * @returns The binding, or null if not found
   * @throws RepositoryError on query failure
   */
  getByAtprotoHandle(handle: string): Promise<IdentityBinding | null>;

  /**
   * Alias for getByAtprotoHandle (used in Phase 4/5)
   *
   * @param handle - The handle (e.g., alice.pod.example)
   * @returns The binding, or null if not found
   * @throws RepositoryError on query failure
   */
  findByHandle?(handle: string): Promise<IdentityBinding | null>;

  /**
   * Retrieve binding by ActivityPub actor URI
   *
   * @param actorUri - The actor URI (e.g., https://pod.example/alice)
   * @returns The binding, or null if not found
   * @throws RepositoryError on query failure
   */
  getByActivityPubActorUri(actorUri: string): Promise<IdentityBinding | null>;

  /**
   * Retrieve binding by WebID
   *
   * @param webId - The WebID (e.g., https://pod.example/alice/profile/card#me)
   * @returns The binding, or null if not found
   * @throws RepositoryError on query failure
   */
  getByWebId(webId: string): Promise<IdentityBinding | null>;

  /**
   * Retrieve binding by context and username
   *
   * @param contextId - The pod/context ID
   * @param username - The username
   * @returns The binding, or null if not found
   * @throws RepositoryError on query failure
   */
  getByContextAndUsername(
    contextId: string,
    username: string
  ): Promise<IdentityBinding | null>;

  /**
   * Create a new binding
   *
   * @param binding - The binding to create
   * @throws RepositoryError if binding already exists or validation fails
   */
  create(binding: IdentityBinding): Promise<void>;

  /**
   * Update an existing binding
   *
   * @param binding - The binding to update
   * @throws RepositoryError if binding not found or update fails
   */
  update(binding: IdentityBinding): Promise<void>;

  /**
   * Upsert a binding (create if not exists, update if exists)
   *
   * @param binding - The binding to upsert
   * @throws RepositoryError on persistence failure
   */
  upsert(binding: IdentityBinding): Promise<void>;

  /**
   * Delete a binding by canonical account ID
   *
   * @param canonicalAccountId - The account ID
   * @returns true if deleted, false if not found
   * @throws RepositoryError on deletion failure
   */
  delete(canonicalAccountId: string): Promise<boolean>;

  /**
   * List all bindings in a context
   *
   * @param contextId - The pod/context ID
   * @param limit - Maximum number of results (default 100)
   * @param offset - Pagination offset (default 0)
   * @returns Array of bindings
   * @throws RepositoryError on query failure
   */
  listByContext(
    contextId: string,
    limit?: number,
    offset?: number
  ): Promise<IdentityBinding[]>;

  /**
   * List all bindings with a specific status
   *
   * @param status - The status to filter by
   * @param limit - Maximum number of results (default 100)
   * @param offset - Pagination offset (default 0)
   * @returns Array of bindings
   * @throws RepositoryError on query failure
   */
  listByStatus(
    status: 'active' | 'suspended' | 'deactivated',
    limit?: number,
    offset?: number
  ): Promise<IdentityBinding[]>;

  /**
   * List all bindings with pending PLC updates
   *
   * @param limit - Maximum number of results (default 100)
   * @param offset - Pagination offset (default 0)
   * @returns Array of bindings with PLC state
   * @throws RepositoryError on query failure
   */
  listWithPendingPlcUpdates(
    limit?: number,
    offset?: number
  ): Promise<IdentityBinding[]>;

  /**
   * Count total bindings in a context
   *
   * @param contextId - The pod/context ID
   * @returns Total count
   * @throws RepositoryError on query failure
   */
  countByContext(contextId: string): Promise<number>;

  /**
   * Check if a binding exists by canonical account ID
   *
   * @param canonicalAccountId - The account ID
   * @returns true if exists, false otherwise
   * @throws RepositoryError on query failure
   */
  exists(canonicalAccountId: string): Promise<boolean>;

  /**
   * Check if a DID is already bound
   *
   * @param did - The DID to check
   * @returns true if bound, false otherwise
   * @throws RepositoryError on query failure
   */
  didExists(did: string): Promise<boolean>;

  /**
   * Check if a handle is already bound
   *
   * @param handle - The handle to check
   * @returns true if bound, false otherwise
   * @throws RepositoryError on query failure
   */
  handleExists(handle: string): Promise<boolean>;

  /**
   * Check if an actor URI is already bound
   *
   * @param actorUri - The actor URI to check
   * @returns true if bound, false otherwise
   * @throws RepositoryError on query failure
   */
  actorUriExists(actorUri: string): Promise<boolean>;

  /**
   * Batch retrieve bindings by canonical account IDs
   *
   * @param canonicalAccountIds - Array of account IDs
   * @returns Map of account ID to binding (missing IDs not included)
   * @throws RepositoryError on query failure
   */
  getBatch(
    canonicalAccountIds: string[]
  ): Promise<Map<string, IdentityBinding>>;

  /**
   * Transaction support for atomic operations
   *
   * @param callback - Function to execute within transaction
   * @throws RepositoryError on transaction failure
   */
  transaction<T>(
    callback: (repo: IdentityBindingRepository) => Promise<T>
  ): Promise<T>;

  /**
   * Health check
   *
   * @returns true if repository is healthy
   */
  health(): Promise<boolean>;
}

/**
 * Query builder for complex identity binding queries
 */
export interface IdentityBindingQueryBuilder {
  /**
   * Filter by context
   */
  whereContext(contextId: string): IdentityBindingQueryBuilder;

  /**
   * Filter by status
   */
  whereStatus(
    status: 'active' | 'suspended' | 'deactivated'
  ): IdentityBindingQueryBuilder;

  /**
   * Filter by DID method
   */
  whereDidMethod(method: 'did:plc' | 'did:web'): IdentityBindingQueryBuilder;

  /**
   * Filter by creation date range
   */
  whereCreatedBetween(
    startDate: string,
    endDate: string
  ): IdentityBindingQueryBuilder;

  /**
   * Filter by PLC update state
   */
  wherePlcUpdateState(state: string): IdentityBindingQueryBuilder;

  /**
   * Order results
   */
  orderBy(field: string, direction: 'asc' | 'desc'): IdentityBindingQueryBuilder;

  /**
   * Limit results
   */
  limit(count: number): IdentityBindingQueryBuilder;

  /**
   * Offset results
   */
  offset(count: number): IdentityBindingQueryBuilder;

  /**
   * Execute query
   */
  execute(): Promise<IdentityBinding[]>;

  /**
   * Execute and count
   */
  count(): Promise<number>;
}
