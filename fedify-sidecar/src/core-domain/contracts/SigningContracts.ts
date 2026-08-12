/**
 * V6.5 Signing Contracts - Protocol-Specific Key and Signature Interfaces
 *
 * Defines the contracts for:
 * - ActivityPub HTTP signature generation
 * - ATProto commit signing
 * - ATProto DID update (PLC) signing
 * - Public key retrieval and management
 */

import type { PublicSearchConsentSignal } from "../../utils/searchConsent.js";

/**
 * Phase 1 scaffolding for Fedify runtime integration.
 *
 * This adapter is intentionally narrow and side-effect free by default.
 * Implementations can emit metrics/traces or delegate to Fedify framework
 * primitives when ENABLE_FEDIFY_RUNTIME_INTEGRATION=true.
 */
export interface FederationRuntimeAdapter {
  readonly name: string;
  readonly enabled: boolean;
  deliverOutbound?(input: OutboundDeliveryInput): Promise<OutboundDeliveryResult> | OutboundDeliveryResult;
  onInboundVerified?(input: {
    actorUri: string;
    activityId?: string;
    activityType?: string;
    isPublic?: boolean;
  }): Promise<void> | void;
  onOutboundDelivered?(input: {
    actorUri: string;
    activityId: string;
    targetDomain: string;
    statusCode?: number;
    meta?: OutboundDeliveryMeta;
  }): Promise<void> | void;
  onOutboundPermanentFailure?(input: {
    actorUri: string;
    activityId: string;
    targetDomain: string;
    targetInbox: string;
    statusCode?: number;
    error: string;
    responseBody?: string;
    attempt: number;
    meta?: OutboundDeliveryMeta;
  }): Promise<void> | void;
}

export const NoopFederationRuntimeAdapter: FederationRuntimeAdapter = {
  name: "noop",
  enabled: false,
};

export interface OutboundDeliverySignatureHeaders {
  date: string;
  digest?: string;
  signature: string;
}

export interface OutboundDeliveryModerationReportMeta {
  protocol: "activitypub";
  caseId: string;
  canonicalIntentId: string;
  targetActorUri?: string;
}

export interface OutboundDeliveryMeta {
  isPublicActivity?: boolean;
  isPublicIndexable?: boolean;
  isDeleteOrTombstone?: boolean;
  visibility?: "public" | "unlisted" | "followers" | "direct";
  searchConsent?: PublicSearchConsentSignal;
  moderationReport?: OutboundDeliveryModerationReportMeta;
  /**
   * APDM-internal first durable outbound enqueue timestamp. It is set once and
   * preserved across retries, deferrals, delayed storage and promotion so the
   * outbound residence horizon cannot be reset by queue transitions.
   */
  apdmFirstQueuedAtMs?: number;
}

export type OutboundDeliverySignResult =
  | {
      ok: true;
      signedHeaders: OutboundDeliverySignatureHeaders;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        permanent: boolean;
      };
    };

export interface OutboundDeliveryInput {
  jobId: string;
  actorUri: string;
  activityId: string;
  activity: string;
  targetInbox: string;
  targetDomain: string;
  attempt: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  userAgent: string;
  signHttpRequest(input: {
    actorUri: string;
    method: "POST";
    targetUrl: string;
    body: string;
  }): Promise<OutboundDeliverySignResult>;
}

export interface OutboundDeliveryResult {
  jobId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  responseBody?: string;
  permanent?: boolean;
  retryAfterMs?: number;
}

/**
 * Protocol-specific error categories surfaced by the signing API.
 */
export type SigningErrorCode =
  | "ACTOR_NOT_FOUND"
  | "KEY_NOT_FOUND"
  | "INVALID_REQUEST"
  | "SIGNING_FAILED"
  | "UNSUPPORTED_KEY_TYPE"
  | "ROTATION_KEY_NOT_FOUND"
  | "ROTATION_SIGNING_FAILED";
