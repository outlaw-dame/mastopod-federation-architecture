/**
 * V6.5 Phase 7: Default AT Write Gateway
 *
 * Orchestrates the canonical-first XRPC write flow:
 *
 *   1. Normalize XRPC input → CanonicalMutationEnvelope
 *   2. Evaluate write policy
 *   3. Register result waiter BEFORE submitting (to survive fast-projection race)
 *   4. Submit envelope to CanonicalClientWriteService (Tier 1)
 *   5. Await projected AT result (URI + CID) from AtWriteResultStore
 *   6. Return Lexicon-compliant XRPC response
 *
 * Design note on ordering: waitForResult is called before applyClientMutation.
 * This ensures the XRPC route never misses a result that arrives before the
 * await is registered — InMemoryAtWriteResultStore handles this via its
 * earlyResults fast-path.
 *
 * For deleteRecord, no URI/CID is needed in the response, so the route
 * fires-and-confirms without waiting for the projection result.
 */

import { XrpcErrors } from '../xrpc/middleware/XrpcErrorMapper.js';
import type {
  AtCreateRecordInput,
  AtPutRecordInput,
  AtDeleteRecordInput,
  AtWriteResult,
  AtDeleteResult,
  AtWriteGateway,
  AtWriteNormalizer,
  AtWritePolicyGate,
  CanonicalClientWriteService,
} from './AtWriteTypes.js';
import type { AtWriteResultStore } from './AtWriteResultStore.js';
import type { AtSessionContext } from '../auth/AtSessionTypes.js';

// ---------------------------------------------------------------------------
// Dependencies injection interface
// ---------------------------------------------------------------------------

export interface DefaultAtWriteGatewayDeps {
  normalizer: AtWriteNormalizer;
  policyGate: AtWritePolicyGate;
  writeService: CanonicalClientWriteService;
  resultStore: AtWriteResultStore;
  /** How long to wait for the projected result before returning 503 (default 10 s) */
  writeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtWriteGateway implements AtWriteGateway {
  private readonly normalizer: AtWriteNormalizer;
  private readonly policyGate: AtWritePolicyGate;
  private readonly writeService: CanonicalClientWriteService;
  private readonly resultStore: AtWriteResultStore;
  private readonly writeTimeoutMs: number;

  constructor(deps: DefaultAtWriteGatewayDeps) {
    this.normalizer    = deps.normalizer;
    this.policyGate    = deps.policyGate;
    this.writeService  = deps.writeService;
    this.resultStore   = deps.resultStore;
    this.writeTimeoutMs = deps.writeTimeoutMs ?? 10_000;
  }

  async createRecord(
    input: AtCreateRecordInput,
    auth: AtSessionContext
  ): Promise<AtWriteResult> {
    const envelope = await this.normalizer.normalizeCreate(input, auth);
    await this._enforcePolicy(envelope, auth);

    // Register waiter BEFORE submit — see design note above
    const resultPromise = this.resultStore.waitForResult(
      envelope.clientMutationId,
      this.writeTimeoutMs
    );

    await this.writeService.applyClientMutation(envelope);

    const result = await resultPromise;
    if (!result) {
      throw XrpcErrors.writeTimeout();
    }
    return result;
  }

  async putRecord(
    input: AtPutRecordInput,
    auth: AtSessionContext
  ): Promise<AtWriteResult> {
    const envelope = await this.normalizer.normalizePut(input, auth);
    await this._enforcePolicy(envelope, auth);

    const resultPromise = this.resultStore.waitForResult(
      envelope.clientMutationId,
      this.writeTimeoutMs
    );

    await this.writeService.applyClientMutation(envelope);

    const result = await resultPromise;
    if (!result) {
      throw XrpcErrors.writeTimeout();
    }
    return result;
  }

  async deleteRecord(
    input: AtDeleteRecordInput,
    auth: AtSessionContext
  ): Promise<AtDeleteResult> {
    const envelope = await this.normalizer.normalizeDelete(input, auth);
    await this._enforcePolicy(envelope, auth);

    await this.writeService.applyClientMutation(envelope);

    // Delete returns empty body per Lexicon spec — no URI/CID to correlate
    return {};
  }

  // --------------------------------------------------------------------------
  // Policy enforcement
  // --------------------------------------------------------------------------

  private async _enforcePolicy(
    envelope: Parameters<AtWritePolicyGate['evaluate']>[0],
    auth: AtSessionContext
  ): Promise<void> {
    const decision = await this.policyGate.evaluate(envelope, auth);
    if (decision.decision !== 'REJECT') return;

    const msg = decision.message ?? 'Write rejected by policy';
    switch (decision.reasonCode) {
      case 'UnsupportedCollection':
        throw XrpcErrors.unsupportedCollection(msg);
      case 'Forbidden':
        throw XrpcErrors.forbidden(msg);
      case 'WriteNotAllowed':
        throw XrpcErrors.writeNotAllowed(msg);
      default:
        throw XrpcErrors.writeNotAllowed(msg);
    }
  }
}
