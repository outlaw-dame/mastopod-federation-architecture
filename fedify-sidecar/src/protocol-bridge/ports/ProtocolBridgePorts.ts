import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalAttachment } from "../canonical/CanonicalContent.js";
import type { CanonicalIntent } from "../canonical/CanonicalIntent.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProtocolName, CanonicalProvenance } from "../canonical/CanonicalEnvelope.js";
import type { CanonicalLossiness, CanonicalWarning } from "../canonical/CanonicalWarnings.js";
import type { ActivityPubBridgeActivityHints } from "../events/ActivityPubBridgeEvents.js";

export interface ActivityObjectResolutionOptions {
  expectedActorUri?: string | null;
}

export interface TranslationContext {
  now?: () => Date;
  resolveActorRef(ref: CanonicalActorRef): Promise<CanonicalActorRef>;
  resolveObjectRef(ref: CanonicalObjectRef): Promise<CanonicalObjectRef>;
  resolveBlobUrl?(did: string, cid: string): Promise<string | null>;
  resolveActivityObject?(
    activityId: string,
    options?: ActivityObjectResolutionOptions,
  ): Promise<Record<string, unknown> | null>;
}

export interface ProjectionContext extends TranslationContext {
  buildIntentId(intent: Omit<CanonicalIntent, "canonicalIntentId"> | CanonicalIntent): string;
}

export type ProjectionResult<TCommand> =
  | { kind: "success"; commands: TCommand[]; lossiness: CanonicalLossiness; warnings: CanonicalWarning[] }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; code: string; message: string };

export interface ProjectionCommandMetadata {
  canonicalIntentId: string;
  sourceProtocol: ProtocolName;
  provenance: CanonicalProvenance;
  activityPubHints?: ActivityPubBridgeActivityHints;
}

export interface AtAttachmentMediaHint extends Pick<
  CanonicalAttachment,
  "attachmentId" | "mediaType" | "url" | "cid" | "byteSize" | "duration" | "digestMultibase" | "alt" | "width" | "height" | "focalPoint" | "blurhash"
> {}

export interface AtProjectionCommand {
  kind: "createRecord" | "updateRecord" | "deleteRecord";
  collection: string;
  repoDid: string;
  rkey?: string;
  record?: Record<string, unknown>;
  canonicalRefIdHint?: string;
  linkPreviewThumbUrlHint?: string | null;
  attachmentMediaHints?: AtAttachmentMediaHint[];
  metadata?: ProjectionCommandMetadata;
}

export interface ActivityPubProjectionCommand {
  kind: "publishActivity";
  activity: Record<string, unknown>;
  targetTopic: "ap.atproto-ingress.v1" | "ap.outbound.v1";
  metadata?: ProjectionCommandMetadata;
}

export interface AtprotoWritePort {
  apply(commands: AtProjectionCommand[]): Promise<void>;
}

export interface ActivityPubPublishPort {
  publish(commands: ActivityPubProjectionCommand[]): Promise<void>;
}

export interface PolicyPort {
  evaluate(intent: CanonicalIntent): Promise<{ allowed: boolean; warnings?: CanonicalWarning[]; reason?: string }>;
}

export interface ProjectionLedgerRecord {
  canonicalIntentId: string;
  sourceProtocol: ProtocolName;
  projectedToActivityPub: boolean;
  projectedToAtproto: boolean;
  firstSeenAt: string;
  lastProjectedAt: string;
}

export interface ProjectionLedgerPort {
  get(canonicalIntentId: string): Promise<ProjectionLedgerRecord | null>;
  markProjected(canonicalIntentId: string, sourceProtocol: ProtocolName, targetProtocol: ProtocolName): Promise<void>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: "full";
}

export interface RetryClassifier {
  isTransient(error: unknown): boolean;
}
