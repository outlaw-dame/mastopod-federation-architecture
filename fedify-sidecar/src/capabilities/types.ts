export type ProviderProfile = "ap-core" | "ap-scale" | "dual-protocol-standard";

export type CapabilityStatus = "enabled" | "disabled" | "beta" | "deprecated";

/**
 * A single entry in the events catalog advertised in ProviderCapabilitiesDocument.
 * `dlqTopic` names the dead-letter topic used when delivery to this topic fails
 * permanently.  `dlqSemantics` describes whether the DLQ is for initial delivery
 * failures ("dead-letter") or exhausted-retry survivors ("retry-dlq").
 */
export interface TopicEventEntry {
  name: string;
  schema: string;
  retentionDays: number;
  replay: boolean;
  dlqTopic?: string;
  dlqSemantics?: "dead-letter" | "retry-dlq";
}

export interface ProtocolStatus {
  enabled: boolean;
  version?: string;
  status: CapabilityStatus;
  disabledReason?: string;
}

export interface CapabilityEntry {
  id: string;
  version: string;
  status: CapabilityStatus;
  dependencies: string[];
  limits: Record<string, string | number | boolean>;
  disabledReason?: string;
}

export interface EntitlementOverride {
  capabilityId: string;
  type: "limit" | "enable" | "disable";
  field: string;
  value: string | number | boolean;
}

export interface ProviderCapabilitiesDocument {
  schemaVersion: "1.0.0";
  provider: {
    id: string;
    displayName: string;
    region: string;
  };
  profiles: {
    active: ProviderProfile[];
    supported: ProviderProfile[];
  };
  protocols: {
    activitypub: ProtocolStatus;
    atproto: ProtocolStatus;
  };
  capabilities: CapabilityEntry[];
  entitlements: {
    plan: string;
    effectiveAt: string;
    overrides: EntitlementOverride[];
  };
  degradation: {
    modes: Array<{
      when: string;
      behavior: string;
      contractRef: string;
    }>;
  };
  events: {
    catalogVersion: string;
    topics: TopicEventEntry[];
  };
  security: {
    internalApisAuth: "bearer";
    signingKeysLocation: "activitypods-only";
    failClosed: boolean;
  };
}

export interface ProviderCapabilitiesBuildInput {
  providerId: string;
  providerDisplayName: string;
  providerRegion: string;
  profile: ProviderProfile;
  plan: string;
  enableInboundWorker: boolean;
  enableOutboundWorker: boolean;
  enableOpenSearchIndexer: boolean;
  enableXrpcServer: boolean;
  enableMediaPipeline: boolean;
  enableMrf: boolean;
  atprotoEnabled: boolean;
  firehoseRetentionDays: number;
  includeAtDisabledEntries: boolean;
  /** Whether the canonical event log Kafka topic is active. */
  enableCanonicalEventLog?: boolean;
  /** Whether the in-process unified fan-out stream is active. */
  enableUnifiedFeed?: boolean;
}

export interface StartupValidationIssue {
  severity: "warning" | "fatal";
  ruleId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface StartupValidationResult {
  ok: boolean;
  issues: StartupValidationIssue[];
}
