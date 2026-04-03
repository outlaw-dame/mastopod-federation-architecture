import type { CanonicalAudience } from "./CanonicalAudience.js";
import type { CanonicalActorRef } from "./CanonicalActorRef.js";
import type { CanonicalWarning } from "./CanonicalWarnings.js";

export type ProtocolName = "activitypub" | "atproto";

export interface CanonicalProvenance {
  originProtocol: ProtocolName;
  originEventId: string;
  originAccountId?: string | null;
  mirroredFromCanonicalIntentId?: string | null;
  projectionMode: "native" | "mirrored";
}

export interface CanonicalIntentBase {
  canonicalIntentId: string;
  sourceProtocol: ProtocolName;
  sourceEventId: string;
  sourceAccountRef: CanonicalActorRef;
  createdAt: string;
  observedAt: string;
  visibility: CanonicalAudience;
  provenance: CanonicalProvenance;
  warnings: CanonicalWarning[];
}
