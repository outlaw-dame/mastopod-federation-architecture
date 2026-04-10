/**
 * V6.5 PLC State Machine - did:plc Update Lifecycle Management
 *
 * Manages the state transitions for did:plc operations:
 * - PENDING_SUBMISSION: Ready to submit to PLC directory
 * - SUBMITTED: Submitted, awaiting confirmation
 * - CONFIRMED: Confirmed by PLC directory
 * - FAILED: Permanent failure
 * - STALE: Timed out, needs resubmission
 *
 * This state machine ensures reliable DID updates with proper retry logic.
 */

import { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';

/**
 * PLC operation types
 */
export type PlcOperationType =
  | 'create'        // Initial DID creation
  | 'rotate_key'    // Key rotation
  | 'update_handle' // Handle update
  | 'update_service' // Service endpoint update
  | 'recover';      // Account recovery

/**
 * PLC operation request
 */
export interface PlcOperationRequest {
  /**
   * Operation type
   */
  type: PlcOperationType;

  /**
   * DID being updated
   */
  did: string;

  /**
   * Operation-specific data
   */
  data: Record<string, any>;

  /**
   * Rotation key reference for signing
   */
  rotationKeyRef: string;

  /**
   * Previous operation CID (for chaining)
   */
  prevOpCid?: string;
}

/**
 * PLC operation response
 */
export interface PlcOperationResponse {
  /**
   * Operation CID
   */
  opCid: string;

  /**
   * DID
   */
  did: string;

  /**
   * Confirmed state from PLC directory
   */
  confirmed: boolean;

  /**
   * Current operation CID from directory
   */
  currentOpCid: string;

  /**
   * Timestamp of operation
   */
  timestamp: string;
}

/**
 * PLC State Machine
 *
 * Manages state transitions for did:plc operations.
 */
export class PlcStateMachine {
  /**
   * Submission timeout (milliseconds)
   * After this time, a SUBMITTED operation is marked STALE
   */
  private readonly SUBMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Maximum retry attempts
   */
  private readonly MAX_RETRIES = 3;

  /**
   * Transition to PENDING_SUBMISSION
   *
   * @param binding - The identity binding
   * @param operation - The operation to submit
   * @returns Updated binding
   */
  transitionToPendingSubmission(
    binding: IdentityBinding,
    operation: PlcOperationRequest
  ): IdentityBinding {
    if (!binding.plc) {
      throw new Error('PLC state not initialized');
    }

    const updated = { ...binding };
    updated.plc = {
      ...binding.plc,
      plcUpdateState: 'PENDING_SUBMISSION',
      lastError: null,
    };
    updated.updatedAt = new Date().toISOString();

    return updated;
  }

  /**
   * Transition to SUBMITTED
   *
   * @param binding - The identity binding
   * @param opCid - The operation CID
   * @returns Updated binding
   */
  transitionToSubmitted(binding: IdentityBinding, opCid: string): IdentityBinding {
    if (!binding.plc) {
      throw new Error('PLC state not initialized');
    }

    const updated = { ...binding };
    updated.plc = {
      ...binding.plc,
      opCid,
      plcUpdateState: 'SUBMITTED',
      lastSubmittedAt: new Date().toISOString(),
      lastError: null,
    };
    updated.updatedAt = new Date().toISOString();

    return updated;
  }

  /**
   * Transition to CONFIRMED
   *
   * @param binding - The identity binding
   * @param opCid - The confirmed operation CID
   * @returns Updated binding
   */
  transitionToConfirmed(binding: IdentityBinding, opCid: string): IdentityBinding {
    if (!binding.plc) {
      throw new Error('PLC state not initialized');
    }

    const updated = { ...binding };
    updated.plc = {
      ...binding.plc,
      opCid,
      plcUpdateState: 'CONFIRMED',
      lastConfirmedAt: new Date().toISOString(),
      lastError: null,
    };
    updated.updatedAt = new Date().toISOString();

    return updated;
  }

  /**
   * Transition to FAILED
   *
   * @param binding - The identity binding
   * @param error - Error message
   * @returns Updated binding
   */
  transitionToFailed(binding: IdentityBinding, error: string): IdentityBinding {
    if (!binding.plc) {
      throw new Error('PLC state not initialized');
    }

    const updated = { ...binding };
    updated.plc = {
      ...binding.plc,
      plcUpdateState: 'FAILED',
      lastError: error,
    };
    updated.updatedAt = new Date().toISOString();

    return updated;
  }

  /**
   * Transition to STALE
   *
   * @param binding - The identity binding
   * @returns Updated binding
   */
  transitionToStale(binding: IdentityBinding): IdentityBinding {
    if (!binding.plc) {
      throw new Error('PLC state not initialized');
    }

    const updated = { ...binding };
    updated.plc = {
      ...binding.plc,
      plcUpdateState: 'STALE',
      lastError: 'Operation timed out',
    };
    updated.updatedAt = new Date().toISOString();

    return updated;
  }

  /**
   * Check if operation is stale
   *
   * @param binding - The identity binding
   * @returns true if stale
   */
  isOperationStale(binding: IdentityBinding): boolean {
    if (!binding.plc || !binding.plc.lastSubmittedAt) {
      return false;
    }

    const submittedTime = new Date(binding.plc.lastSubmittedAt).getTime();
    const now = Date.now();
    const elapsed = now - submittedTime;

    return elapsed > this.SUBMISSION_TIMEOUT_MS;
  }

  /**
   * Check if operation can be retried
   *
   * @param binding - The identity binding
   * @returns true if can retry
   */
  canRetry(binding: IdentityBinding): boolean {
    if (!binding.plc) {
      return false;
    }

    const state = binding.plc.plcUpdateState;

    // Can retry from FAILED or STALE states
    if (state === 'FAILED' || state === 'STALE') {
      return true;
    }

    // Can retry SUBMITTED if stale
    if (state === 'SUBMITTED' && this.isOperationStale(binding)) {
      return true;
    }

    return false;
  }

  /**
   * Get state transition path
   *
   * @param binding - The identity binding
   * @returns Array of states from current to target
   */
  getTransitionPath(binding: IdentityBinding): string[] {
    if (!binding.plc) {
      return [];
    }

    const current = binding.plc.plcUpdateState;

    switch (current) {
      case 'PENDING_SUBMISSION':
        return ['PENDING_SUBMISSION', 'SUBMITTED', 'CONFIRMED'];
      case 'SUBMITTED':
        return ['SUBMITTED', 'CONFIRMED'];
      case 'CONFIRMED':
        return ['CONFIRMED']; // Terminal state
      case 'FAILED':
        return ['FAILED', 'PENDING_SUBMISSION', 'SUBMITTED', 'CONFIRMED'];
      case 'STALE':
        return ['STALE', 'PENDING_SUBMISSION', 'SUBMITTED', 'CONFIRMED'];
      default:
        return [];
    }
  }

  /**
   * Validate state transition
   *
   * @param from - Current state
   * @param to - Target state
   * @returns true if valid transition
   */
  isValidTransition(
    from: string | null | undefined,
    to: string
  ): boolean {
    const validTransitions: Record<string, string[]> = {
      null: ['PENDING_SUBMISSION'],
      PENDING_SUBMISSION: ['SUBMITTED', 'FAILED'],
      SUBMITTED: ['CONFIRMED', 'FAILED', 'STALE'],
      CONFIRMED: [], // Terminal
      FAILED: ['PENDING_SUBMISSION'],
      STALE: ['PENDING_SUBMISSION'],
    };

    const current = from || 'null';
    const allowed = validTransitions[current] || [];

    return allowed.includes(to);
  }

  /**
   * Get retry delay (exponential backoff)
   *
   * @param attemptNumber - Attempt number (1-based)
   * @returns Delay in milliseconds
   */
  getRetryDelay(attemptNumber: number): number {
    // Exponential backoff: 1s, 2s, 4s
    const baseDelay = 1000;
    const delay = baseDelay * Math.pow(2, attemptNumber - 1);
    const maxDelay = 30000; // 30 seconds

    return Math.min(delay, maxDelay);
  }

  /**
   * Format state for logging
   *
   * @param binding - The identity binding
   * @returns Human-readable state description
   */
  formatState(binding: IdentityBinding): string {
    if (!binding.plc) {
      return 'NOT_INITIALIZED';
    }

    const state = binding.plc.plcUpdateState;
    const details: string[] = [state || 'UNKNOWN'];

    if (binding.plc.opCid) {
      details.push(`opCid=${binding.plc.opCid.substring(0, 8)}...`);
    }

    if (binding.plc.lastSubmittedAt) {
      details.push(`submitted=${new Date(binding.plc.lastSubmittedAt).toISOString()}`);
    }

    if (binding.plc.lastConfirmedAt) {
      details.push(`confirmed=${new Date(binding.plc.lastConfirmedAt).toISOString()}`);
    }

    if (binding.plc.lastError) {
      details.push(`error=${binding.plc.lastError}`);
    }

    return details.join(' | ');
  }
}

