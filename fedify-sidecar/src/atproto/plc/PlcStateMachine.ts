/**
 * V6.5 PLC State Machine - did:plc Update Lifecycle Management
 *
 * Manages the state transitions for did:plc operations:
 * - PENDING_SUBMISSION: Ready to submit to PLC directory
 * - SUBMITTED: Submitted, awaiting confirmation
 * - CONFIRMED: Confirmed by PLC directory
 * - FAILED: Permanent failure
 * - STALE: Timed out, needs resubmission
 */

import type {
  IdentityBinding,
  PlcUpdateState,
} from "../../core-domain/identity/IdentityBinding.js";

export type PlcOperationType =
  | "create"
  | "rotate_key"
  | "update_handle"
  | "update_service"
  | "recover";

export interface PlcOperationRequest {
  type: PlcOperationType;
  did: string;
  data: Record<string, unknown>;
  rotationKeyRef: string;
  prevOpCid?: string;
}

export interface PlcOperationResponse {
  opCid: string;
  did: string;
  confirmed: boolean;
  currentOpCid: string;
  timestamp: string;
}

export class PlcStateMachine {
  private readonly submissionTimeoutMs = 5 * 60 * 1000;

  transitionToPendingSubmission(
    binding: IdentityBinding,
    _operation: PlcOperationRequest
  ): IdentityBinding {
    return this.withPlcState(binding, {
      plcUpdateState: "PENDING_SUBMISSION",
      lastError: null,
    });
  }

  transitionToSubmitted(binding: IdentityBinding, opCid: string): IdentityBinding {
    return this.withPlcState(binding, {
      opCid,
      plcUpdateState: "SUBMITTED",
      lastSubmittedAt: new Date().toISOString(),
      lastError: null,
    });
  }

  transitionToConfirmed(binding: IdentityBinding, opCid: string): IdentityBinding {
    return this.withPlcState(binding, {
      opCid,
      plcUpdateState: "CONFIRMED",
      lastConfirmedAt: new Date().toISOString(),
      lastError: null,
    });
  }

  transitionToFailed(binding: IdentityBinding, error: string): IdentityBinding {
    return this.withPlcState(binding, {
      plcUpdateState: "FAILED",
      lastError: error,
    });
  }

  transitionToStale(binding: IdentityBinding): IdentityBinding {
    return this.withPlcState(binding, {
      plcUpdateState: "STALE",
      lastError: "Operation timed out",
    });
  }

  isOperationStale(binding: IdentityBinding): boolean {
    const lastSubmittedAt = binding.plc?.lastSubmittedAt;
    if (!lastSubmittedAt) {
      return false;
    }

    return Date.now() - new Date(lastSubmittedAt).getTime() > this.submissionTimeoutMs;
  }

  canRetry(binding: IdentityBinding): boolean {
    const state = binding.plc?.plcUpdateState;
    if (!state) {
      return false;
    }

    if (state === "FAILED" || state === "STALE") {
      return true;
    }

    return state === "SUBMITTED" && this.isOperationStale(binding);
  }

  getTransitionPath(binding: IdentityBinding): PlcUpdateState[] {
    const current = binding.plc?.plcUpdateState;

    switch (current) {
      case "PENDING_SUBMISSION":
        return ["PENDING_SUBMISSION", "SUBMITTED", "CONFIRMED"];
      case "SUBMITTED":
        return ["SUBMITTED", "CONFIRMED"];
      case "CONFIRMED":
        return ["CONFIRMED"];
      case "FAILED":
        return ["FAILED", "PENDING_SUBMISSION", "SUBMITTED", "CONFIRMED"];
      case "STALE":
        return ["STALE", "PENDING_SUBMISSION", "SUBMITTED", "CONFIRMED"];
      default:
        return [];
    }
  }

  isValidTransition(
    from: PlcUpdateState | null | undefined,
    to: PlcUpdateState
  ): boolean {
    const validTransitions: Record<string, PlcUpdateState[]> = {
      null: ["PENDING_SUBMISSION"],
      PENDING_SUBMISSION: ["SUBMITTED", "FAILED"],
      SUBMITTED: ["CONFIRMED", "FAILED", "STALE"],
      CONFIRMED: [],
      FAILED: ["PENDING_SUBMISSION"],
      STALE: ["PENDING_SUBMISSION"],
    };

    const current = from ?? "null";
    return (validTransitions[current] ?? []).includes(to);
  }

  getRetryDelay(attemptNumber: number): number {
    const delay = 1000 * Math.pow(2, attemptNumber - 1);
    return Math.min(delay, 30000);
  }

  formatState(binding: IdentityBinding): string {
    if (!binding.plc) {
      return "NOT_INITIALIZED";
    }

    const details: string[] = [binding.plc.plcUpdateState ?? "UNKNOWN"];

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

    return details.join(" | ");
  }

  private withPlcState(
    binding: IdentityBinding,
    plcPatch: Partial<NonNullable<IdentityBinding["plc"]>>
  ): IdentityBinding {
    if (!binding.plc) {
      throw new Error("PLC state not initialized");
    }

    return {
      ...binding,
      plc: {
        ...binding.plc,
        ...plcPatch,
      },
      updatedAt: new Date().toISOString(),
    };
  }
}
