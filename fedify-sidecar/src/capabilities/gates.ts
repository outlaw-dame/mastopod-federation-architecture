import { ProviderCapabilitiesDocument } from "./types.js";

export type CapabilityGateReasonCode = "feature_disabled" | "limit_exceeded" | "protocol_disabled";

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

  return { allowed: true, capabilityId };
}
