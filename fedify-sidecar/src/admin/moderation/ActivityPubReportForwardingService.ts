import { request, type Dispatcher } from "undici";
import { withRetry } from "../mrf/utils.js";
import { createOutboxIntent, type RedisStreamsQueue } from "../../queue/sidecar-redis-queue.js";
import { isSafeTargetInboxUrl, sanitizeErrorText, sanitizeResponseBodySnippet } from "../../delivery/outbound-worker.js";
import type { CanonicalV1Event } from "../../streams/v6-topology.js";
import type {
  OutboundDeliveryModerationReportMeta,
} from "../../core-domain/contracts/SigningContracts.js";
import { validateRelayActorUrl } from "../../federation/relay/ApRelaySubscriptionService.js";
import type { ActivityPodsModerationCaseStore } from "./activitypods-case-store.js";
import type {
  ModerationCase,
  ModerationCaseActivityPubForwardingState,
} from "./types.js";

const ACCEPT_ACTIVITYPUB =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_RETRIES = 2;
const DEFAULT_FETCH_RETRY_BASE_MS = 250;
const DEFAULT_FETCH_RETRY_MAX_MS = 2_500;
const MAX_ACTIVITY_OBJECTS = 20;
const MAX_REASON_LENGTH = 2_000;
export const DEFAULT_MODERATION_ACTOR_IDENTIFIER = "moderation";

// ---------------------------------------------------------------------------
// Provider actor identity — canonical rename of the moderation actor
// ---------------------------------------------------------------------------

/**
 * Canonical identifier for the sidecar-owned provider actor.
 * Replaces the legacy "moderation" identifier going forward.
 * Actor document is served at /users/provider; inbox at /users/provider/inbox.
 */
export const PROVIDER_ACTOR_IDENTIFIER = "provider";

/**
 * Legacy identifiers kept for backward compatibility with existing federations
 * that know the provider actor as /users/moderation.
 * The actor dispatcher serves all of these with the same key pair.
 */
export const PROVIDER_ACTOR_LEGACY_IDENTIFIERS = ["moderation"] as const;

/**
 * All identifiers (canonical + legacy) that the actor dispatcher must register
 * as sidecar-owned service actors.
 */
export const ALL_PROVIDER_ACTOR_IDENTIFIERS = [
  PROVIDER_ACTOR_IDENTIFIER,
  ...PROVIDER_ACTOR_LEGACY_IDENTIFIERS,
] as const;

/**
 * Returns the complete set of URIs under which the provider actor is reachable:
 *   https://domain/users/provider  (canonical)
 *   https://domain/actor           (Mastodon instance-actor compat)
 *   https://domain/users/moderation (legacy alias)
 *
 * Used by the inbound worker to classify shared-inbox activities that are
 * addressed to the provider actor when inspecting to/cc/audience fields.
 */
export function buildProviderActorUriSet(domain: string): Set<string> {
  return new Set([
    `https://${domain}/users/${PROVIDER_ACTOR_IDENTIFIER}`,
    `https://${domain}/actor`,
    ...PROVIDER_ACTOR_LEGACY_IDENTIFIERS.map((id) => `https://${domain}/users/${id}`),
  ]);
}

/**
 * Inbox paths that are exclusively owned by the provider actor.
 * Excludes /inbox (shared inbox) — shared-inbox provider-directed traffic
 * is classified by inspecting the activity's to/cc/audience/object fields.
 */
export const PROVIDER_ACTOR_INBOX_PATHS: ReadonlySet<string> = new Set([
  `/users/${PROVIDER_ACTOR_IDENTIFIER}/inbox`,
  "/actor/inbox",
  ...PROVIDER_ACTOR_LEGACY_IDENTIFIERS.map((id) => `/users/${id}/inbox`),
]);

export interface ActivityPubReportForwardingLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: ActivityPubReportForwardingLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ActivityPubReportForwardingResult {
  status: "ignored" | "skipped" | "queued" | "already-forwarded" | "failed";
  caseId?: string;
  canonicalIntentId?: string;
  reason?: string;
}

interface ReportForwardingServiceConfig {
  domain: string;
  moderationActorIdentifier?: string;
  userAgent?: string;
  fetchTimeoutMs?: number;
  fetchRetries?: number;
  fetchRetryBaseMs?: number;
  fetchRetryMaxMs?: number;
}

interface FetchActivityPubDocumentResult {
  url: string;
  document: Record<string, unknown>;
}

interface ResolvedReportSubject {
  targetActorUri: string;
  flagObjectIds: string[];
}

class ActivityPubReportForwardingError extends Error {
  constructor(
    message: string,
    readonly options: {
      retryable?: boolean;
      skipped?: boolean;
      skippedReason?: string;
      statusCode?: number;
      responseBody?: string;
      targetActorUri?: string;
      targetInbox?: string;
      targetDomain?: string;
    } = {},
  ) {
    super(message);
    this.name = "ActivityPubReportForwardingError";
  }

  get retryable(): boolean {
    return this.options.retryable === true;
  }

  get skipped(): boolean {
    return this.options.skipped === true;
  }
}

export class ActivityPubReportForwardingService {
  private readonly moderationActorIdentifier: string;
  private readonly userAgent: string;
  private readonly fetchTimeoutMs: number;
  private readonly fetchRetries: number;
  private readonly fetchRetryBaseMs: number;
  private readonly fetchRetryMaxMs: number;
  private readonly requestImpl: typeof request;
  private readonly logger: ActivityPubReportForwardingLogger;

  constructor(
    private readonly queue: Pick<RedisStreamsQueue, "enqueueOutboxIntent">,
    private readonly caseStore: Pick<ActivityPodsModerationCaseStore, "getCase" | "patchCase">,
    config: ReportForwardingServiceConfig,
    logger?: ActivityPubReportForwardingLogger,
    requestImpl: typeof request = request,
  ) {
    this.moderationActorIdentifier = normalizeModerationActorIdentifier(
      config.moderationActorIdentifier ?? DEFAULT_MODERATION_ACTOR_IDENTIFIER,
    );
    this.userAgent = config.userAgent?.trim() || "Fedify-Sidecar/1.0 (ActivityPods) moderation-reports";
    this.fetchTimeoutMs = Math.max(1_000, config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    this.fetchRetries = Math.max(0, config.fetchRetries ?? DEFAULT_FETCH_RETRIES);
    this.fetchRetryBaseMs = Math.max(25, config.fetchRetryBaseMs ?? DEFAULT_FETCH_RETRY_BASE_MS);
    this.fetchRetryMaxMs = Math.max(this.fetchRetryBaseMs, config.fetchRetryMaxMs ?? DEFAULT_FETCH_RETRY_MAX_MS);
    this.requestImpl = requestImpl;
    this.logger = logger ?? NOOP_LOGGER;
    this.domain = config.domain;
  }

  private readonly domain: string;

  async handleCanonicalEvent(event: CanonicalV1Event): Promise<ActivityPubReportForwardingResult> {
    if (event.kind !== "ReportCreate") {
      return { status: "ignored" };
    }

    const caseId = extractLocalCaseId(event.sourceProtocol, event.sourceEventId);
    if (!caseId) {
      return { status: "ignored" };
    }

    const caseRecord = await this.caseStore.getCase(caseId);
    if (!caseRecord) {
      this.logger.warn("ActivityPub report forwarding skipped missing case", {
        caseId,
        canonicalIntentId: event.canonicalIntentId,
      });
      return {
        status: "ignored",
        caseId,
        canonicalIntentId: event.canonicalIntentId,
      };
    }

    if (caseRecord.source !== "local-user-report" || event.sourceProtocol !== "activitypods") {
      return {
        status: "ignored",
        caseId,
        canonicalIntentId: event.canonicalIntentId,
      };
    }

    const existingState = caseRecord.forwarding?.activityPub;
    if (
      existingState?.canonicalIntentId === event.canonicalIntentId
      && (existingState.status === "queued" || existingState.status === "delivered")
    ) {
      return {
        status: "already-forwarded",
        caseId,
        canonicalIntentId: event.canonicalIntentId,
      };
    }

    const moderationActorUri = buildModerationActorUri(this.domain, this.moderationActorIdentifier);
    const attemptAt = new Date().toISOString();

    try {
      if (!caseRecord.requestedForwarding?.remote) {
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
          moderationActorUri,
          skippedReason: "not_requested",
          lastAttemptAt: attemptAt,
        });
        return {
          status: "skipped",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: "not_requested",
        };
      }

      if (caseRecord.subject.authoritativeProtocol !== "ap") {
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
          moderationActorUri,
          skippedReason: "authoritative_protocol_not_activitypub",
          lastAttemptAt: attemptAt,
        });
        return {
          status: "skipped",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: "authoritative_protocol_not_activitypub",
        };
      }

      await this.patchActivityPubForwarding(caseRecord, {
        status: "pending",
        canonicalIntentId: event.canonicalIntentId,
        moderationActorUri,
        activityId: undefined,
        outboxIntentId: undefined,
        targetActorUri: undefined,
        targetInbox: undefined,
        targetDomain: undefined,
        lastAttemptAt: attemptAt,
        queuedAt: undefined,
        deliveredAt: undefined,
        lastError: undefined,
        skippedReason: undefined,
        lastStatusCode: undefined,
      });

      const resolvedSubject = await this.resolveReportSubject(caseRecord);
      const targetActorHost = new URL(resolvedSubject.targetActorUri).hostname.toLowerCase();
      if (targetActorHost === this.domain.toLowerCase()) {
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
          moderationActorUri,
          targetActorUri: resolvedSubject.targetActorUri,
          targetDomain: targetActorHost,
          skippedReason: "local_target",
          lastAttemptAt: new Date().toISOString(),
        });
        return {
          status: "skipped",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: "local_target",
        };
      }

      const actorDocument = await this.fetchActivityPubDocument(resolvedSubject.targetActorUri);
      const targetInbox = this.extractPreferredInbox(actorDocument.document);
      const targetDomain = new URL(targetInbox).hostname.toLowerCase();
      const activityId = buildModerationFlagActivityId(
        this.domain,
        event.canonicalIntentId,
        this.moderationActorIdentifier,
      );
      const outboxIntentId = buildModerationOutboxIntentId(event.canonicalIntentId);
      const deliveryMeta: OutboundDeliveryModerationReportMeta = {
        protocol: "activitypub",
        caseId,
        canonicalIntentId: event.canonicalIntentId,
        targetActorUri: resolvedSubject.targetActorUri,
      };
      const flagContent = buildFlagContent(caseRecord.reason);
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: activityId,
        type: "Flag",
        actor: moderationActorUri,
        object: resolvedSubject.flagObjectIds,
        to: [resolvedSubject.targetActorUri],
        published: new Date().toISOString(),
        ...(flagContent ? { content: flagContent } : {}),
      };

      await this.queue.enqueueOutboxIntent(
        createOutboxIntent({
          intentId: outboxIntentId,
          activityId,
          actorUri: moderationActorUri,
          activity: JSON.stringify(activity),
          targets: [
            {
              inboxUrl: targetInbox,
              deliveryUrl: targetInbox,
              targetDomain,
            },
          ],
          meta: {
            moderationReport: deliveryMeta,
            visibility: "direct",
            isPublicActivity: false,
            isPublicIndexable: false,
          },
        }),
      );

      await this.patchActivityPubForwarding(caseRecord, {
        status: "queued",
        canonicalIntentId: event.canonicalIntentId,
        moderationActorUri,
        activityId,
        outboxIntentId,
        targetActorUri: resolvedSubject.targetActorUri,
        targetInbox,
        targetDomain,
        queuedAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        lastError: undefined,
        skippedReason: undefined,
        lastStatusCode: undefined,
      });

      this.logger.info("Queued outbound ActivityPub moderation Flag", {
        caseId,
        canonicalIntentId: event.canonicalIntentId,
        activityId,
        moderationActorUri,
        targetActorUri: resolvedSubject.targetActorUri,
        targetInbox,
      });

      return {
        status: "queued",
        caseId,
        canonicalIntentId: event.canonicalIntentId,
      };
    } catch (error) {
      const forwardingError = normalizeForwardingError(error);
      const lastAttemptAt = new Date().toISOString();

      if (forwardingError.skipped) {
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
          moderationActorUri,
          targetActorUri: forwardingError.options.targetActorUri,
          targetInbox: forwardingError.options.targetInbox,
          targetDomain: forwardingError.options.targetDomain,
          skippedReason: forwardingError.options.skippedReason ?? "skipped",
          lastAttemptAt,
        });
        return {
          status: "skipped",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: forwardingError.options.skippedReason ?? "skipped",
        };
      }

      if (!forwardingError.retryable) {
        await this.markFailed(caseRecord.id, {
          protocol: "activitypub",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          targetActorUri: forwardingError.options.targetActorUri,
        }, {
          error: forwardingError.message,
          targetDomain: forwardingError.options.targetDomain,
          targetInbox: forwardingError.options.targetInbox,
          statusCode: forwardingError.options.statusCode,
          responseBody: forwardingError.options.responseBody,
          attempt: 1,
          moderationActorUri,
          lastAttemptAt,
        });
        return {
          status: "failed",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: "failed",
        };
      }

      await this.bestEffortPendingPatch(caseRecord, {
        status: "pending",
        canonicalIntentId: event.canonicalIntentId,
        moderationActorUri,
        targetActorUri: forwardingError.options.targetActorUri,
        targetInbox: forwardingError.options.targetInbox,
        targetDomain: forwardingError.options.targetDomain,
        lastAttemptAt,
        lastError: forwardingError.message,
        lastStatusCode: normalizeStatusCode(forwardingError.options.statusCode),
      });

      throw forwardingError;
    }
  }

  async markDelivered(
    meta: OutboundDeliveryModerationReportMeta,
    input: {
      targetDomain: string;
      statusCode?: number;
    },
  ): Promise<void> {
    const caseRecord = await this.caseStore.getCase(meta.caseId);
    if (!caseRecord) return;

    await this.patchActivityPubForwarding(caseRecord, {
      status: "delivered",
      canonicalIntentId: meta.canonicalIntentId,
      targetActorUri: meta.targetActorUri,
      targetDomain: input.targetDomain,
      deliveredAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: undefined,
      skippedReason: undefined,
      lastStatusCode: normalizeStatusCode(input.statusCode),
    });
  }

  async markFailed(
    caseId: string,
    meta: OutboundDeliveryModerationReportMeta,
    input: {
      error: string;
      targetDomain?: string;
      targetInbox?: string;
      statusCode?: number;
      responseBody?: string;
      attempt: number;
      moderationActorUri?: string;
      lastAttemptAt?: string;
    },
  ): Promise<void> {
    const caseRecord = await this.caseStore.getCase(caseId);
    if (!caseRecord) return;

    const lastError = buildFailureMessage(input.error, input.responseBody);
    await this.patchActivityPubForwarding(caseRecord, {
      status: "failed",
      canonicalIntentId: meta.canonicalIntentId,
      moderationActorUri: input.moderationActorUri,
      targetActorUri: meta.targetActorUri,
      targetInbox: input.targetInbox,
      targetDomain: input.targetDomain,
      lastAttemptAt: input.lastAttemptAt ?? new Date().toISOString(),
      lastError,
      lastStatusCode: normalizeStatusCode(input.statusCode),
    });

    this.logger.warn("ActivityPub moderation Flag delivery failed", {
      caseId,
      canonicalIntentId: meta.canonicalIntentId,
      targetActorUri: meta.targetActorUri,
      targetInbox: input.targetInbox,
      targetDomain: input.targetDomain,
      statusCode: input.statusCode,
      attempt: input.attempt,
      error: lastError,
    });
  }

  private async resolveReportSubject(caseRecord: ModerationCase): Promise<ResolvedReportSubject> {
    if (caseRecord.subject.kind === "account") {
      const targetActorUri = requireValidatedActivityPubUrl(
        caseRecord.subject.actor.activityPubActorUri,
        "subject.actor.activityPubActorUri",
      );
      return {
        targetActorUri,
        flagObjectIds: collectFlagObjectIds(caseRecord, targetActorUri),
      };
    }

    const fallbackObjectUrl =
      caseRecord.subject.object.activityPubObjectId
      ?? safeOptionalActivityPubUrl(caseRecord.subject.object.canonicalUrl)
      ?? null;
    let targetActorUri = safeOptionalActivityPubUrl(caseRecord.subject.owner?.activityPubActorUri) ?? null;
    let resolvedObjectUrl = fallbackObjectUrl;

    if (!targetActorUri) {
      if (!fallbackObjectUrl) {
        throw new ActivityPubReportForwardingError(
          "Reported ActivityPub object is missing both an owner actor URI and a resolvable object URI",
          { retryable: false },
        );
      }

      const objectDocument = await this.fetchActivityPubDocument(fallbackObjectUrl);
      targetActorUri = extractObjectOwnerActorUri(objectDocument.document);
      resolvedObjectUrl = extractObjectId(objectDocument.document) ?? resolvedObjectUrl;
    }

    if (!targetActorUri) {
      throw new ActivityPubReportForwardingError(
        "Reported ActivityPub object could not be resolved to an owning actor",
        { retryable: false },
      );
    }

    return {
      targetActorUri,
      flagObjectIds: collectFlagObjectIds(caseRecord, targetActorUri, resolvedObjectUrl),
    };
  }

  private async fetchActivityPubDocument(url: string): Promise<FetchActivityPubDocumentResult> {
    const initialUrl = requireValidatedActivityPubUrl(url, "url");
    return withRetry(
      () => this.fetchDocumentOnce(initialUrl, 0),
      {
        retries: this.fetchRetries,
        baseMs: this.fetchRetryBaseMs,
        maxMs: this.fetchRetryMaxMs,
        retryIf: (error) => normalizeForwardingError(error).retryable,
      },
    );
  }

  private async fetchDocumentOnce(
    url: string,
    redirectCount: number,
  ): Promise<FetchActivityPubDocumentResult> {
    let response: Dispatcher.ResponseData;

    try {
      response = await this.requestImpl(url, {
        method: "GET",
        headers: {
          accept: ACCEPT_ACTIVITYPUB,
          "user-agent": this.userAgent,
        },
        headersTimeout: this.fetchTimeoutMs,
        bodyTimeout: this.fetchTimeoutMs,
        maxRedirections: 0,
      });
    } catch (error) {
      throw new ActivityPubReportForwardingError(
        `ActivityPub document request failed: ${
          error instanceof Error ? sanitizeErrorText(error.message) : sanitizeErrorText(error)
        }`,
        { retryable: true },
      );
    }

    if (response.statusCode >= 300 && response.statusCode < 400) {
      if (redirectCount >= 2) {
        throw new ActivityPubReportForwardingError(
          "ActivityPub document resolution exceeded redirect limit",
          { retryable: false, statusCode: response.statusCode },
        );
      }

      const location = response.headers["location"];
      const nextUrl = Array.isArray(location) ? location[0] : location;
      let normalizedRedirect: string | null = null;
      if (nextUrl) {
        try {
          normalizedRedirect = safeOptionalActivityPubUrl(new URL(nextUrl, url).toString());
        } catch {
          normalizedRedirect = null;
        }
      }
      if (!normalizedRedirect) {
        throw new ActivityPubReportForwardingError(
          "ActivityPub document redirect target failed safety validation",
          { retryable: false, statusCode: response.statusCode },
        );
      }

      await response.body.text().catch(() => "");
      return this.fetchDocumentOnce(normalizedRedirect, redirectCount + 1);
    }

    const bodyText = await response.body.text().catch(() => "");
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ActivityPubReportForwardingError(
        `ActivityPub document fetch failed with HTTP ${response.statusCode}`,
        {
          retryable: isRetryableStatus(response.statusCode),
          statusCode: response.statusCode,
          responseBody: sanitizeResponseBodySnippet(bodyText),
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ActivityPubReportForwardingError(
        "ActivityPub document response was not valid JSON",
        { retryable: false, statusCode: response.statusCode },
      );
    }

    if (!isRecord(parsed)) {
      throw new ActivityPubReportForwardingError(
        "ActivityPub document response was not a JSON object",
        { retryable: false, statusCode: response.statusCode },
      );
    }

    return {
      url,
      document: parsed,
    };
  }

  private extractPreferredInbox(document: Record<string, unknown>): string {
    const inbox = normalizeSafeInboxUrl(document["inbox"]);
    if (inbox) return inbox;

    const endpoints = isRecord(document["endpoints"]) ? document["endpoints"] : null;
    const sharedInbox = normalizeSafeInboxUrl(endpoints?.["sharedInbox"]);
    if (sharedInbox) return sharedInbox;

    throw new ActivityPubReportForwardingError(
      "Resolved ActivityPub actor does not expose a safe inbox",
      { retryable: false },
    );
  }

  private async patchActivityPubForwarding(
    caseRecord: ModerationCase,
    patch: Partial<ModerationCaseActivityPubForwardingState> & {
      status: ModerationCaseActivityPubForwardingState["status"];
    },
  ): Promise<void> {
    const current = await this.caseStore.getCase(caseRecord.id);
    if (!current) {
      throw new Error(`Moderation case ${caseRecord.id} disappeared while updating forwarding state`);
    }

    const nextState = compactActivityPubForwardingState({
      ...(current.forwarding?.activityPub ?? {}),
      ...patch,
      status: patch.status,
    });

    const updated = await this.caseStore.patchCase(current.id, {
      forwarding: {
        ...(current.forwarding ?? {}),
        activityPub: nextState,
      },
      updatedAt:
        nextState.deliveredAt
        ?? nextState.lastAttemptAt
        ?? current.updatedAt
        ?? current.receivedAt,
    });

    if (!updated) {
      throw new Error(`Moderation case ${caseRecord.id} disappeared while updating forwarding state`);
    }
  }

  private async markSkipped(
    caseRecord: ModerationCase,
    patch: Partial<ModerationCaseActivityPubForwardingState> & {
      canonicalIntentId: string;
      skippedReason: string;
      lastAttemptAt: string;
    },
  ): Promise<void> {
    await this.patchActivityPubForwarding(caseRecord, {
      status: "skipped",
      canonicalIntentId: patch.canonicalIntentId,
      moderationActorUri: patch.moderationActorUri,
      targetActorUri: patch.targetActorUri,
      targetInbox: patch.targetInbox,
      targetDomain: patch.targetDomain,
      skippedReason: patch.skippedReason,
      lastAttemptAt: patch.lastAttemptAt,
      activityId: undefined,
      outboxIntentId: undefined,
      queuedAt: undefined,
      deliveredAt: undefined,
      lastError: undefined,
      lastStatusCode: undefined,
    });
  }

  private async bestEffortPendingPatch(
    caseRecord: ModerationCase,
    patch: Partial<ModerationCaseActivityPubForwardingState> & {
      status: ModerationCaseActivityPubForwardingState["status"];
      canonicalIntentId: string;
      lastAttemptAt: string;
    },
  ): Promise<void> {
    try {
      await this.patchActivityPubForwarding(caseRecord, patch);
    } catch (error) {
      this.logger.warn("Failed to persist pending ActivityPub report forwarding state", {
        caseId: caseRecord.id,
        canonicalIntentId: patch.canonicalIntentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function buildModerationActorUri(
  domain: string,
  identifier: string = DEFAULT_MODERATION_ACTOR_IDENTIFIER,
): string {
  return `https://${domain}/users/${normalizeModerationActorIdentifier(identifier)}`;
}

export function buildModerationFlagActivityId(
  domain: string,
  canonicalIntentId: string,
  identifier: string = DEFAULT_MODERATION_ACTOR_IDENTIFIER,
): string {
  return `${buildModerationActorUri(domain, identifier)}/flags/${canonicalIntentId}`;
}

export function buildModerationOutboxIntentId(canonicalIntentId: string): string {
  return `moderation-report:${canonicalIntentId}`;
}

function extractLocalCaseId(sourceProtocol: CanonicalV1Event["sourceProtocol"], sourceEventId: string): string | null {
  if (sourceProtocol !== "activitypods") return null;
  const prefix = "activitypods:report:";
  if (!sourceEventId.startsWith(prefix)) return null;
  const caseId = sourceEventId.slice(prefix.length).trim();
  return caseId.length > 0 ? caseId : null;
}

function normalizeModerationActorIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    throw new Error("Moderation actor identifier failed validation");
  }
  return trimmed;
}

function normalizeSafeInboxUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  return isSafeTargetInboxUrl(trimmed) ? trimmed : null;
}

function safeOptionalActivityPubUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return validateRelayActorUrl(value)?.href ?? null;
}

function requireValidatedActivityPubUrl(value: unknown, field: string): string {
  const normalized = safeOptionalActivityPubUrl(value);
  if (!normalized) {
    throw new ActivityPubReportForwardingError(
      `${field} failed ActivityPub URL safety validation`,
      { retryable: false },
    );
  }
  return normalized;
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractObjectOwnerActorUri(document: Record<string, unknown>): string | null {
  const directOwner = safeOptionalActivityPubUrl(document["attributedTo"]);
  if (directOwner) return directOwner;

  const activityActor = safeOptionalActivityPubUrl(document["actor"]);
  if (activityActor) return activityActor;

  const nestedObject = isRecord(document["object"]) ? document["object"] : null;
  if (nestedObject) {
    const nestedOwner = safeOptionalActivityPubUrl(nestedObject["attributedTo"]);
    if (nestedOwner) return nestedOwner;
  }

  return null;
}

function extractObjectId(document: Record<string, unknown>): string | null {
  const directId = safeOptionalActivityPubUrl(document["id"]);
  if (directId) return directId;

  const nestedObject = isRecord(document["object"]) ? document["object"] : null;
  if (!nestedObject) return null;

  return safeOptionalActivityPubUrl(nestedObject["id"]);
}

function collectFlagObjectIds(
  caseRecord: ModerationCase,
  targetActorUri: string,
  resolvedSubjectObjectId?: string | null,
): string[] {
  const ordered = new Set<string>();
  ordered.add(targetActorUri);

  const addObjectId = (value: unknown) => {
    const normalized = safeOptionalActivityPubUrl(value);
    if (normalized) {
      ordered.add(normalized);
    }
  };

  if (caseRecord.subject.kind === "object") {
    addObjectId(resolvedSubjectObjectId ?? caseRecord.subject.object.activityPubObjectId);
    addObjectId(caseRecord.subject.object.canonicalUrl);
  }

  for (const entry of caseRecord.evidenceObjectRefs.slice(0, MAX_ACTIVITY_OBJECTS)) {
    addObjectId(entry.activityPubObjectId);
    addObjectId(entry.canonicalUrl);
  }

  return Array.from(ordered).slice(0, MAX_ACTIVITY_OBJECTS + 1);
}

function buildFlagContent(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const trimmed = reason.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_REASON_LENGTH);
}

function compactActivityPubForwardingState(
  value: ModerationCaseActivityPubForwardingState,
): ModerationCaseActivityPubForwardingState {
  return {
    status: value.status,
    ...(value.canonicalIntentId ? { canonicalIntentId: value.canonicalIntentId } : {}),
    ...(value.moderationActorUri ? { moderationActorUri: value.moderationActorUri } : {}),
    ...(value.activityId ? { activityId: value.activityId } : {}),
    ...(value.outboxIntentId ? { outboxIntentId: value.outboxIntentId } : {}),
    ...(value.targetActorUri ? { targetActorUri: value.targetActorUri } : {}),
    ...(value.targetInbox ? { targetInbox: value.targetInbox } : {}),
    ...(value.targetDomain ? { targetDomain: value.targetDomain } : {}),
    ...(value.lastAttemptAt ? { lastAttemptAt: value.lastAttemptAt } : {}),
    ...(value.queuedAt ? { queuedAt: value.queuedAt } : {}),
    ...(value.deliveredAt ? { deliveredAt: value.deliveredAt } : {}),
    ...(value.lastError ? { lastError: value.lastError } : {}),
    ...(value.skippedReason ? { skippedReason: value.skippedReason } : {}),
    ...(normalizeStatusCode(value.lastStatusCode) !== undefined
      ? { lastStatusCode: normalizeStatusCode(value.lastStatusCode) }
      : {}),
  };
}

function buildFailureMessage(error: string, responseBody?: string): string {
  const sanitizedError = sanitizeErrorText(error);
  const sanitizedBody = sanitizeResponseBodySnippet(responseBody);
  return sanitizedBody ? `${sanitizedError} (${sanitizedBody})` : sanitizedError;
}

function normalizeStatusCode(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : undefined;
}

function normalizeForwardingError(error: unknown): ActivityPubReportForwardingError {
  if (error instanceof ActivityPubReportForwardingError) {
    return error;
  }

  return new ActivityPubReportForwardingError(
    error instanceof Error ? sanitizeErrorText(error.message) : sanitizeErrorText(error),
    { retryable: true },
  );
}
