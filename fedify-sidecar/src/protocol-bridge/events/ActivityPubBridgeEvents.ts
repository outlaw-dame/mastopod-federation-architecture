import type { CanonicalProvenance, ProtocolName } from "../canonical/CanonicalEnvelope.js";

export interface ActivityPubBridgeActivityHints {
  noteLinkPreviewUrls?: string[];
}

export interface ActivityPubBridgeMetadata {
  canonicalIntentId: string;
  sourceProtocol: ProtocolName;
  provenance: CanonicalProvenance;
  activityPubHints?: ActivityPubBridgeActivityHints;
}

export interface ActivityPubBridgeIngressEvent {
  version: 1;
  activityId: string;
  actor: string;
  activity: Record<string, unknown>;
  bridge: ActivityPubBridgeMetadata;
  receivedAt: string;
}

export interface ActivityPubBridgeOutboundDelivery {
  jobId?: string;
  actor: string;
  targetDomain?: string;
  recipients: string[];
  sharedInbox?: string;
}

export interface ActivityPubBridgeOutboundEvent extends ActivityPubBridgeOutboundDelivery {
  activity: Record<string, unknown>;
  bridge: ActivityPubBridgeMetadata;
  timestamp: number;
}
