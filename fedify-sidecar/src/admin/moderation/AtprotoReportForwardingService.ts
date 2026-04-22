import { withRetry } from "../mrf/utils.js";
import { sanitizeErrorText, sanitizeResponseBodySnippet } from "../../delivery/outbound-worker.js";
import type { CanonicalV1Event } from "../../streams/v6-topology.js";
import type {
  AtprotoForwardingPlan,
  ActivityPodsModerationCaseStore,
} from "./activitypods-case-store.js";
import type {
  ModerationCase,
  ModerationCaseAtprotoForwardingState,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_RETRIES = 2;
const DEFAULT_REQUEST_RETRY_BASE_MS = 250;
const DEFAULT_REQUEST_RETRY_MAX_MS = 2_500;

export interface AtprotoReportForwardingLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: AtprotoReportForwardingLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface AtprotoReportForwardingResult {
  status: "ignored" | "skipped" | "delivered" | "already-forwarded" | "failed";
  caseId?: string;
  canonicalIntentId?: string;
  reason?: string;
}

interface AtprotoReportForwardingServiceConfig {
  requestTimeoutMs?: number;
  requestRetries?: number;
  requestRetryBaseMs?: number;
  requestRetryMaxMs?: number;
}

class AtprotoReportForwardingError extends Error {
  constructor(
    message: string,
    readonly options: {
      retryable?: boolean;
      skipped?: boolean;
      skippedReason?: string;
      statusCode?: number;
      responseBody?: string;
      serviceDid?: string;
      pdsUrl?: string;
      subjectDid?: string;
      subjectAtUri?: string;
    } = {},
  ) {
    super(message);
    this.name = "AtprotoReportForwardingError";
  }

  get retryable(): boolean {
    return this.options.retryable === true;
  }

  get skipped(): boolean {
    return this.options.skipped === true;
  }
}

export class AtprotoReportForwardingService {
  private readonly requestTimeoutMs: number;
  private readonly requestRetries: number;
  private readonly requestRetryBaseMs: number;
  private readonly requestRetryMaxMs: number;
  private readonly logger: AtprotoReportForwardingLogger;

  constructor(
    private readonly caseStore: Pick<
      ActivityPodsModerationCaseStore,
      "getCase" | "patchCase" | "prepareAtprotoForwardingPlan"
    >,
    config: AtprotoReportForwardingServiceConfig = {},
    logger?: AtprotoReportForwardingLogger,
  ) {
    this.requestTimeoutMs = Math.max(1_000, config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.requestRetries = Math.max(0, config.requestRetries ?? DEFAULT_REQUEST_RETRIES);
    this.requestRetryBaseMs = Math.max(25, config.requestRetryBaseMs ?? DEFAULT_REQUEST_RETRY_BASE_MS);
    this.requestRetryMaxMs = Math.max(
      this.requestRetryBaseMs,
      config.requestRetryMaxMs ?? DEFAULT_REQUEST_RETRY_MAX_MS,
    );
    this.logger = logger ?? NOOP_LOGGER;
  }

  async handleCanonicalEvent(event: CanonicalV1Event): Promise<AtprotoReportForwardingResult> {
    if (event.kind !== "ReportCreate") {
      return { status: "ignored" };
    }

    const caseId = extractLocalCaseId(event.sourceProtocol, event.sourceEventId);
    if (!caseId) {
      return { status: "ignored" };
    }

    const caseRecord = await this.caseStore.getCase(caseId);
    if (!caseRecord) {
      this.logger.warn("ATProto report forwarding skipped missing case", {
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

    const existingState = caseRecord.forwarding?.atproto;
    if (
      existingState?.canonicalIntentId === event.canonicalIntentId
      && existingState.status === "delivered"
    ) {
      return {
        status: "already-forwarded",
        caseId,
        canonicalIntentId: event.canonicalIntentId,
      };
    }

    const attemptAt = new Date().toISOString();

    try {
      if (!caseRecord.requestedForwarding?.remote) {
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
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

      if (caseRecord.subject.authoritativeProtocol !== "at") {
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
          skippedReason: "authoritative_protocol_not_atproto",
          lastAttemptAt: attemptAt,
        });
        return {
          status: "skipped",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: "authoritative_protocol_not_atproto",
        };
      }

      await this.patchAtprotoForwarding(caseRecord, {
        status: "pending",
        canonicalIntentId: event.canonicalIntentId,
        lastAttemptAt: attemptAt,
        lastError: undefined,
        skippedReason: undefined,
        lastStatusCode: undefined,
      });

      const plan = await this.caseStore.prepareAtprotoForwardingPlan(caseRecord.id, {
        canonicalIntentId: event.canonicalIntentId,
      });

      if (!plan || plan.status !== "ready") {
        const skippedReason = sanitizeSkippedReason(plan?.reason ?? "forwarding_plan_unavailable");
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
          skippedReason,
          lastAttemptAt: new Date().toISOString(),
          serviceDid: plan?.serviceDid,
          pdsUrl: plan?.pdsUrl,
          reporterDid: plan?.reporterDid,
          reporterHandle: plan?.reporterHandle,
          subjectDid: plan?.subjectDid,
          subjectAtUri: plan?.subjectAtUri,
        });
        return {
          status: "skipped",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: skippedReason,
        };
      }

      const delivery = await this.submitReport(plan);
      await this.patchAtprotoForwarding(caseRecord, {
        status: "delivered",
        canonicalIntentId: event.canonicalIntentId,
        serviceDid: plan.serviceDid,
        pdsUrl: plan.pdsUrl,
        reporterDid: plan.reporterDid,
        reporterHandle: plan.reporterHandle,
        subjectDid: plan.subjectDid,
        subjectAtUri: plan.subjectAtUri,
        reportId: delivery.reportId,
        deliveredAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        lastError: undefined,
        skippedReason: undefined,
        lastStatusCode: normalizeStatusCode(delivery.statusCode),
      });

      this.logger.info("Delivered outbound ATProto moderation report", {
        caseId,
        canonicalIntentId: event.canonicalIntentId,
        serviceDid: plan.serviceDid,
        pdsUrl: plan.pdsUrl,
        subjectDid: plan.subjectDid,
        subjectAtUri: plan.subjectAtUri,
        reportId: delivery.reportId,
      });

      return {
        status: "delivered",
        caseId,
        canonicalIntentId: event.canonicalIntentId,
      };
    } catch (error) {
      const forwardingError = normalizeForwardingError(error);
      const lastAttemptAt = new Date().toISOString();

      if (forwardingError.skipped) {
        await this.markSkipped(caseRecord, {
          canonicalIntentId: event.canonicalIntentId,
          skippedReason: sanitizeSkippedReason(
            forwardingError.options.skippedReason ?? "skipped",
          ),
          lastAttemptAt,
          serviceDid: forwardingError.options.serviceDid,
          pdsUrl: forwardingError.options.pdsUrl,
          subjectDid: forwardingError.options.subjectDid,
          subjectAtUri: forwardingError.options.subjectAtUri,
        });
        return {
          status: "skipped",
          caseId,
          canonicalIntentId: event.canonicalIntentId,
          reason: forwardingError.options.skippedReason ?? "skipped",
        };
      }

      if (!forwardingError.retryable) {
        await this.patchAtprotoForwarding(caseRecord, {
          status: "failed",
          canonicalIntentId: event.canonicalIntentId,
          serviceDid: forwardingError.options.serviceDid,
          pdsUrl: forwardingError.options.pdsUrl,
          subjectDid: forwardingError.options.subjectDid,
          subjectAtUri: forwardingError.options.subjectAtUri,
          lastAttemptAt,
          lastError: buildFailureMessage(
            forwardingError.message,
            forwardingError.options.responseBody,
          ),
          lastStatusCode: normalizeStatusCode(forwardingError.options.statusCode),
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
        serviceDid: forwardingError.options.serviceDid,
        pdsUrl: forwardingError.options.pdsUrl,
        subjectDid: forwardingError.options.subjectDid,
        subjectAtUri: forwardingError.options.subjectAtUri,
        lastAttemptAt,
        lastError: buildFailureMessage(
          forwardingError.message,
          forwardingError.options.responseBody,
        ),
        lastStatusCode: normalizeStatusCode(forwardingError.options.statusCode),
      });

      throw forwardingError;
    }
  }

  private async submitReport(plan: AtprotoForwardingPlan): Promise<{ reportId?: number; statusCode: number }> {
    const pdsUrl = requireValidatedPdsUrl(plan.pdsUrl, "plan.pdsUrl");
    const accessJwt = requireBearerToken(plan.accessJwt, "plan.accessJwt");
    const serviceDid = requireDid(plan.serviceDid, "plan.serviceDid");
    const requestBody = requireRequestBody(plan.request);
    const endpoint = new URL("/xrpc/com.atproto.moderation.createReport", pdsUrl).toString();

    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `Bearer ${accessJwt}`,
              "atproto-proxy": `${serviceDid}#atproto_labeler`,
              "cache-control": "no-store",
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
        } catch (error) {
          throw new AtprotoReportForwardingError(
            `ATProto moderation request failed: ${
              error instanceof Error ? sanitizeErrorText(error.message) : sanitizeErrorText(error)
            }`,
            {
              retryable: true,
              serviceDid,
              pdsUrl,
              subjectDid: plan.subjectDid,
              subjectAtUri: plan.subjectAtUri,
            },
          );
        }

        const text = await response.text();
        const payload = text ? safeParseJson<Record<string, unknown>>(text) : null;
        if (!response.ok) {
          throw new AtprotoReportForwardingError(
            response.status === 401 || response.status === 403
              ? "ATProto moderation service rejected reporter credentials"
              : `ATProto moderation report failed (${response.status})`,
            {
              retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
              statusCode: response.status,
              responseBody: sanitizeResponseBodySnippet(text),
              serviceDid,
              pdsUrl,
              subjectDid: plan.subjectDid,
              subjectAtUri: plan.subjectAtUri,
            },
          );
        }

        const reportId = typeof payload?.["id"] === "number" ? payload["id"] : undefined;
        return {
          reportId,
          statusCode: response.status,
        };
      },
      {
        retries: this.requestRetries,
        baseMs: this.requestRetryBaseMs,
        maxMs: this.requestRetryMaxMs,
        retryIf: (error) => normalizeForwardingError(error).retryable,
      },
    );
  }

  private async patchAtprotoForwarding(
    caseRecord: ModerationCase,
    patch: Partial<ModerationCaseAtprotoForwardingState>,
  ): Promise<void> {
    const next = await this.caseStore.patchCase(caseRecord.id, {
      forwarding: {
        ...(caseRecord.forwarding ?? {}),
        atproto: {
          ...(caseRecord.forwarding?.atproto ?? {}),
          ...patch,
        } as ModerationCaseAtprotoForwardingState,
      },
      updatedAt: new Date().toISOString(),
    });

    if (!next) {
      throw new Error(`Moderation case ${caseRecord.id} disappeared while updating ATProto forwarding state`);
    }
  }

  private async markSkipped(
    caseRecord: ModerationCase,
    patch: Partial<ModerationCaseAtprotoForwardingState>,
  ): Promise<void> {
    await this.patchAtprotoForwarding(caseRecord, {
      ...patch,
      status: "skipped",
      lastError: undefined,
    });
  }

  private async bestEffortPendingPatch(
    caseRecord: ModerationCase,
    patch: Partial<ModerationCaseAtprotoForwardingState>,
  ): Promise<void> {
    try {
      await this.patchAtprotoForwarding(caseRecord, patch);
    } catch (error) {
      this.logger.warn("Failed to persist pending ATProto report forwarding state", {
        caseId: caseRecord.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function extractLocalCaseId(sourceProtocol: string, sourceEventId: string): string | null {
  if (sourceProtocol !== "activitypods") return null;
  const prefix = "activitypods:report:";
  if (!sourceEventId.startsWith(prefix)) return null;
  const value = sourceEventId.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function normalizeForwardingError(error: unknown): AtprotoReportForwardingError {
  if (error instanceof AtprotoReportForwardingError) {
    return error;
  }

  return new AtprotoReportForwardingError(
    error instanceof Error ? sanitizeErrorText(error.message) : sanitizeErrorText(error),
    { retryable: true },
  );
}

function buildFailureMessage(message: string, responseBody?: string): string {
  const sanitizedMessage = sanitizeErrorText(message).slice(0, 512);
  if (!responseBody) return sanitizedMessage;
  const sanitizedBody = (sanitizeResponseBodySnippet(responseBody) ?? "").slice(0, 512);
  return `${sanitizedMessage} [response=${sanitizedBody}]`.slice(0, 1024);
}

function normalizeStatusCode(statusCode: unknown): number | undefined {
  return typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : undefined;
}

function sanitizeSkippedReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 128) || "skipped";
}

function requireValidatedPdsUrl(value: string | undefined, field: string): string {
  const candidate = String(value ?? "").trim();
  if (!candidate) {
    throw new AtprotoReportForwardingError(`${field} is required`, { retryable: false });
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AtprotoReportForwardingError(`${field} must be a valid URL`, { retryable: false });
  }

  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) || parsed.username || parsed.password) {
    throw new AtprotoReportForwardingError(`${field} must use https or localhost http`, {
      retryable: false,
    });
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function requireBearerToken(value: string | undefined, field: string): string {
  const token = String(value ?? "").trim();
  if (!token || token.length < 20) {
    throw new AtprotoReportForwardingError(`${field} is missing or invalid`, { retryable: false });
  }
  return token;
}

function requireDid(value: string | undefined, field: string): string {
  const did = String(value ?? "").trim();
  if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/i.test(did)) {
    throw new AtprotoReportForwardingError(`${field} must be a valid DID`, { retryable: false });
  }
  return did;
}

function requireRequestBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AtprotoReportForwardingError("ATProto moderation request body is missing or invalid", {
      retryable: false,
    });
  }
  return value as Record<string, unknown>;
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
