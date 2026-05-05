import { ProviderCapabilitiesDocument } from "./types.js";

export type CapabilityGateReasonCode =
  | "feature_disabled"
  | "limit_exceeded"
  | "protocol_disabled"
  | "unauthorized_app"
  | "user_verification_required";

export interface CapabilityGateResult {
  allowed: boolean;
  capabilityId: string;
  reasonCode?: CapabilityGateReasonCode;
  message?: string;
  retryable?: boolean;
}

function findCapability(document: ProviderCapabilitiesDocument, capabilityId: string) {
  return document.capabilities.find((entry) => entry.id === capabilityId);
}

export function evaluateCapabilityGate(
  document: ProviderCapabilitiesDocument,
  capabilityId: string,
  runtimeInput: Record<string, unknown> = {},
): CapabilityGateResult {
  const capability = findCapability(document, capabilityId);

  if (!capability || capability.status === "disabled") {
    return {
      allowed: false,
      capabilityId,
      reasonCode: "feature_disabled",
      message: `Capability ${capabilityId} is disabled for this provider profile`,
      retryable: false,
    };
  }

  if (capabilityId.startsWith("at.") && !document.protocols.atproto.enabled) {
    return {
      allowed: false,
      capabilityId,
      reasonCode: "protocol_disabled",
      message: "ATProto protocol is disabled by provider policy",
      retryable: false,
    };
  }

  if (capabilityId === "provider.account.provisioning") {
    const approvedApp = runtimeInput["approvedApp"] === true;
    const verifiedUser = runtimeInput["verifiedUser"] === true;

    if (!approvedApp || !verifiedUser) {
      return {
        allowed: false,
        capabilityId,
        reasonCode: approvedApp ? "user_verification_required" : "unauthorized_app",
        message: approvedApp
          ? "Account provisioning requires user verification"
          : "Account provisioning is only available to approved applications",
        retryable: approvedApp,
      };
    }
  }

  return { allowed: true, capabilityId };
}
