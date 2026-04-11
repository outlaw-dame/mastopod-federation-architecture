import { ProviderCapabilitiesDocument, ProviderProfile, StartupValidationIssue, StartupValidationResult } from "./types.js";

function findCapability(document: ProviderCapabilitiesDocument, capabilityId: string) {
  return document.capabilities.find((entry) => entry.id === capabilityId);
}

function isEnabled(document: ProviderCapabilitiesDocument, capabilityId: string): boolean {
  const capability = findCapability(document, capabilityId);
  return capability?.status === "enabled";
}

function pushFatal(
  issues: StartupValidationIssue[],
  ruleId: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  issues.push({ severity: "fatal", ruleId, code, message, details });
}

export function validateProviderCapabilitiesConfig(
  document: ProviderCapabilitiesDocument,
  options: {
    profile: ProviderProfile;
    hasRedisUrl: boolean;
    hasRedpandaBrokers: boolean;
    hasSigningEndpoint: boolean;
    hasSigningToken: boolean;
    hasOpenSearchUrl: boolean;
    enableMrf: boolean;
  },
): StartupValidationResult {
  const issues: StartupValidationIssue[] = [];

  if (isEnabled(document, "ap.federation.egress")) {
    if (!isEnabled(document, "ap.signing.batch") || !isEnabled(document, "ap.queue.delivery")) {
      pushFatal(issues, "DEP-001", "cap_dependency_missing", "ap.federation.egress requires ap.signing.batch and ap.queue.delivery");
    }
  }

  if (isEnabled(document, "ap.firehose") && !isEnabled(document, "ap.streams")) {
    pushFatal(issues, "DEP-002", "cap_dependency_missing", "ap.firehose requires ap.streams");
  }

  if (isEnabled(document, "ap.search.opensearch") && !isEnabled(document, "ap.firehose")) {
    pushFatal(issues, "DEP-003", "cap_dependency_missing", "ap.search.opensearch requires ap.firehose");
  }

  if (isEnabled(document, "at.identity.binding") && !document.protocols.atproto.enabled) {
    pushFatal(issues, "DEP-004", "cap_protocol_disabled", "at.identity.binding requires atproto protocol enabled");
  }

  if (isEnabled(document, "at.xrpc.server") && !document.protocols.atproto.enabled) {
    pushFatal(issues, "DEP-005", "cap_protocol_disabled", "at.xrpc.server requires atproto protocol enabled");
  }

  if (isEnabled(document, "at.xrpc.repo") && (!document.protocols.atproto.enabled || !isEnabled(document, "at.identity.binding"))) {
    pushFatal(issues, "DEP-006", "cap_dependency_missing", "at.xrpc.repo requires atproto protocol and at.identity.binding");
  }

  if (isEnabled(document, "ap.queue.delivery") && !options.hasRedisUrl) {
    pushFatal(issues, "INF-001", "cap_infra_missing", "ap.queue.delivery requires Redis configuration");
  }

  if (isEnabled(document, "ap.streams") && !options.hasRedpandaBrokers) {
    pushFatal(issues, "INF-002", "cap_infra_missing", "ap.streams requires RedPanda brokers configuration");
  }

  if (isEnabled(document, "ap.search.opensearch") && !options.hasOpenSearchUrl) {
    pushFatal(issues, "INF-003", "cap_infra_missing", "ap.search.opensearch requires OpenSearch URL");
  }

  if (isEnabled(document, "ap.signing.batch") && (!options.hasSigningEndpoint || !options.hasSigningToken)) {
    pushFatal(issues, "INF-004", "cap_infra_missing", "ap.signing.batch requires signing endpoint and token");
  }

  if (options.enableMrf && !isEnabled(document, "ap.mrf")) {
    issues.push({
      severity: "warning",
      ruleId: "INF-005",
      code: "cap_module_load_failed",
      message: "MRF runtime enabled but ap.mrf capability not declared enabled",
    });
  }

  if (options.profile === "ap-core" || options.profile === "ap-scale") {
    const atEnabled = document.capabilities.filter((entry) => entry.id.startsWith("at.") && entry.status === "enabled");
    if (atEnabled.length > 0) {
      pushFatal(issues, "APO-001", "cap_profile_mismatch", "AP-only profiles must not enable at.* capabilities", {
        enabledAtCapabilities: atEnabled.map((entry) => entry.id),
      });
    }
    if (document.protocols.atproto.enabled) {
      pushFatal(issues, "APO-002", "cap_profile_mismatch", "AP-only profiles require atproto protocol disabled");
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "fatal"),
    issues,
  };
}
