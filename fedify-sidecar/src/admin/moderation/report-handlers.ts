import { createHash } from "node:crypto";
import { assertAdminBearer, assertBearerToken } from "../mrf/auth.js";
import { badRequest, internal, notFound } from "../mrf/errors.js";
import { json, parseJson } from "../mrf/utils.js";
import type { CanonicalIntentPublisher } from "../../protocol-bridge/canonical/CanonicalIntentPublisher.js";
import type { CanonicalActorRef } from "../../protocol-bridge/canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../../protocol-bridge/canonical/CanonicalObjectRef.js";
import type { CanonicalReportCreateIntent, CanonicalReportReasonType, CanonicalReportSubject } from "../../protocol-bridge/canonical/CanonicalIntent.js";
import type { CanonicalV1Event } from "../../streams/v6-topology.js";
import type { ActivityPubReportForwardingService } from "./ActivityPubReportForwardingService.js";
import type { AtprotoReportForwardingService } from "./AtprotoReportForwardingService.js";
import type { ModerationBridgeDeps, ModerationCase } from "./types.js";
import { createCanonicalReportCreateIntent } from "./reporting.js";

interface ReportCreateRequestBody {
  caseId: string;
  sourceEventId?: string;
  reporterWebId?: string | null;
  sourceAccountRef?: CanonicalActorRef | null;
  subject?: CanonicalReportSubject;
  reasonType?: CanonicalReportReasonType;
  reason?: string | null;
  evidenceObjectRefs?: CanonicalObjectRef[];
  requestedForwarding?: {
    remote?: boolean;
  } | null;
  clientContext?: {
    app?: string | null;
    surface?: string | null;
  } | null;
  createdAt?: string;
  observedAt?: string;
}

type ForwardingRetryProtocol = "activityPub" | "atproto";

interface ReportForwardingRetryRequestBody {
  protocols?: ForwardingRetryProtocol[] | ForwardingRetryProtocol;
}

type ReportForwardingRetryResult = {
  status: "pending" | "ignored" | "skipped" | "queued" | "delivered" | "already-forwarded" | "failed";
  canonicalIntentId?: string;
  reason?: string;
};

type ReportForwardingRetryResponse = {
  activityPub?: ReportForwardingRetryResult;
  atproto?: ReportForwardingRetryResult;
};

function sanitizeString(value: unknown, field: string, maxLen: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLen) {
    throw badRequest(`${field} exceeds maximum length`);
  }
  return trimmed;
}

function validateIsoDate(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw badRequest(`${field} must be a valid ISO 8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function validateActorRef(value: CanonicalActorRef | null | undefined, field: string): CanonicalActorRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${field} must be an object`);
  }

  const actor: CanonicalActorRef = {
    canonicalAccountId: sanitizeString(value.canonicalAccountId, `${field}.canonicalAccountId`, 512) ?? null,
    did: sanitizeString(value.did, `${field}.did`, 512) ?? null,
    webId: sanitizeString(value.webId, `${field}.webId`, 2048) ?? null,
    activityPubActorUri: sanitizeString(value.activityPubActorUri, `${field}.activityPubActorUri`, 2048) ?? null,
    handle: sanitizeString(value.handle, `${field}.handle`, 512) ?? null,
  };

  if (
    !actor.canonicalAccountId &&
    !actor.did &&
    !actor.webId &&
    !actor.activityPubActorUri &&
    !actor.handle
  ) {
    throw badRequest(`${field} must include at least one identity`);
  }

  return actor;
}

function validateObjectRef(value: CanonicalObjectRef | null | undefined, field: string): CanonicalObjectRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${field} must be an object`);
  }

  const canonicalObjectId =
    sanitizeString(value.canonicalObjectId, `${field}.canonicalObjectId`, 2048) ??
    sanitizeString(value.atUri, `${field}.atUri`, 2048) ??
    sanitizeString(value.activityPubObjectId, `${field}.activityPubObjectId`, 2048) ??
    sanitizeString(value.canonicalUrl, `${field}.canonicalUrl`, 2048);

  if (!canonicalObjectId) {
    throw badRequest(`${field} must include a canonicalObjectId, atUri, activityPubObjectId, or canonicalUrl`);
  }

  return {
    canonicalObjectId,
    atUri: sanitizeString(value.atUri, `${field}.atUri`, 2048) ?? null,
    cid: sanitizeString(value.cid, `${field}.cid`, 512) ?? null,
    activityPubObjectId: sanitizeString(value.activityPubObjectId, `${field}.activityPubObjectId`, 2048) ?? null,
    canonicalUrl: sanitizeString(value.canonicalUrl, `${field}.canonicalUrl`, 2048) ?? null,
  };
}

function validateSubject(value: CanonicalReportSubject | undefined): CanonicalReportSubject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("subject is required");
  }

  if (value.kind === "account") {
    const actor = validateActorRef(value.actor, "subject.actor");
    if (!actor) {
      throw badRequest("subject.actor is required");
    }
    return {
      kind: "account",
      actor,
      authoritativeProtocol: value.authoritativeProtocol,
    };
  }

  if (value.kind === "object") {
    const object = validateObjectRef(value.object, "subject.object");
    if (!object) {
      throw badRequest("subject.object is required");
    }
    return {
      kind: "object",
      object,
      owner: validateActorRef(value.owner, "subject.owner") ?? null,
      authoritativeProtocol: value.authoritativeProtocol,
    };
  }

  throw badRequest("subject.kind must be 'account' or 'object'");
}

function validateReasonType(value: unknown): CanonicalReportReasonType {
  const normalized = sanitizeString(value, "reasonType", 64);
  switch (normalized) {
    case "spam":
    case "harassment":
    case "abuse":
    case "impersonation":
    case "copyright":
    case "illegal":
    case "safety":
    case "other":
      return normalized;
    default:
      throw badRequest("reasonType is invalid");
  }
}

function compactActorRef(value: CanonicalActorRef | null | undefined, field: string): CanonicalActorRef {
  const actor = validateActorRef(value, field);
  if (!actor) {
    throw internal(`${field} is required`);
  }
  return actor;
}

function compactObjectRef(value: CanonicalObjectRef | null | undefined, field: string): CanonicalObjectRef {
  const object = validateObjectRef(value, field);
  if (!object) {
    throw internal(`${field} is required`);
  }
  return object;
}

async function parseOptionalJsonBody<T>(req: Request): Promise<T> {
  const raw = await req.text();
  if (raw.trim().length === 0) {
    return {} as T;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw badRequest("Request body must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object");
  }

  return parsed as T;
}

function determineEligibleRetryProtocols(caseRecord: ModerationCase): ForwardingRetryProtocol[] {
  if (caseRecord.source !== "local-user-report") {
    return [];
  }

  switch (caseRecord.subject.authoritativeProtocol) {
    case "ap":
      return ["activityPub"];
    case "at":
      return ["atproto"];
    default:
      return [];
  }
}

function normalizeRetryProtocols(
  value: ReportForwardingRetryRequestBody["protocols"],
  fallback: ForwardingRetryProtocol[],
): ForwardingRetryProtocol[] {
  if (value === undefined || value === null) {
    return [...fallback];
  }

  const rawValues: unknown[] = Array.isArray(value) ? value : [value];
  const normalized: ForwardingRetryProtocol[] = [];
  for (const entry of rawValues) {
    if (typeof entry !== "string") {
      throw badRequest("protocols must include 'activityPub' or 'atproto'");
    }

    const protocol = entry.trim();
    if (protocol !== "activityPub" && protocol !== "atproto") {
      throw badRequest("protocols must include 'activityPub' or 'atproto'");
    }

    if (!normalized.includes(protocol)) {
      normalized.push(protocol);
    }
  }

  if (normalized.length === 0) {
    throw badRequest("protocols must include 'activityPub' or 'atproto'");
  }

  return normalized;
}

function buildRetryCanonicalIntentId(
  caseId: string,
  protocol: ForwardingRetryProtocol,
  requestId: string,
): string {
  return createHash("sha256")
    .update(`manual-report-forwarding-retry:${caseId}:${protocol}:${requestId}`, "utf8")
    .digest("hex");
}

function buildRetryCanonicalEvent(
  caseRecord: ModerationCase,
  canonicalIntentId: string,
  observedAt: string,
): CanonicalV1Event {
  const actor = compactActorRef(caseRecord.reporter, "reporter");
  const createdAt = caseRecord.createdAt ?? caseRecord.receivedAt;
  const baseEvent: CanonicalV1Event = {
    canonicalIntentId,
    kind: "ReportCreate",
    sourceProtocol: "activitypods",
    sourceEventId: `activitypods:report:${caseRecord.id}`,
    visibility: "direct",
    actor,
    report: {
      subjectKind: caseRecord.subject.kind,
      authoritativeProtocol: caseRecord.subject.authoritativeProtocol,
      reasonType: caseRecord.reasonType,
      reason: caseRecord.reason ?? null,
      evidence: caseRecord.evidenceObjectRefs ?? [],
      requestedForwardingRemote: Boolean(caseRecord.requestedForwarding?.remote),
      clientContext: caseRecord.clientContext ?? null,
    },
    createdAt,
    observedAt,
    timestamp: Date.parse(observedAt),
  };

  if (caseRecord.subject.kind === "account") {
    return {
      ...baseEvent,
      subject: compactActorRef(caseRecord.subject.actor, "subject.actor"),
    };
  }

  return {
    ...baseEvent,
    object: compactObjectRef(caseRecord.subject.object, "subject.object"),
    ...(caseRecord.subject.owner
      ? { subject: compactActorRef(caseRecord.subject.owner, "subject.owner") }
      : {}),
  };
}

async function runActivityPubRetry(
  caseRecord: ModerationCase,
  requestId: string,
  observedAt: string,
  deps: Pick<ModerationBridgeDeps, "store">,
  service: Pick<ActivityPubReportForwardingService, "handleCanonicalEvent">,
): Promise<ReportForwardingRetryResult> {
  const existingState = caseRecord.forwarding?.activityPub;
  if (existingState?.status === "pending" || existingState?.status === "queued") {
    return {
      status: "pending",
      canonicalIntentId: existingState.canonicalIntentId,
      reason: "already_in_progress",
    };
  }
  if (existingState?.status === "delivered") {
    return {
      status: "already-forwarded",
      canonicalIntentId: existingState.canonicalIntentId,
      reason: "already_delivered",
    };
  }

  const canonicalIntentId = buildRetryCanonicalIntentId(caseRecord.id, "activityPub", requestId);
  const event = buildRetryCanonicalEvent(caseRecord, canonicalIntentId, observedAt);

  try {
    return await service.handleCanonicalEvent(event);
  } catch (error) {
    const updatedCase = await deps.store.getCase(caseRecord.id);
    const pendingState = updatedCase?.forwarding?.activityPub;
    if (pendingState?.status === "pending" && pendingState.canonicalIntentId === canonicalIntentId) {
      return {
        status: "pending",
        canonicalIntentId,
        reason: "retryable_error",
      };
    }
    throw error;
  }
}

async function runAtprotoRetry(
  caseRecord: ModerationCase,
  requestId: string,
  observedAt: string,
  deps: Pick<ModerationBridgeDeps, "store">,
  service: Pick<AtprotoReportForwardingService, "handleCanonicalEvent">,
): Promise<ReportForwardingRetryResult> {
  const existingState = caseRecord.forwarding?.atproto;
  if (existingState?.status === "pending") {
    return {
      status: "pending",
      canonicalIntentId: existingState.canonicalIntentId,
      reason: "already_in_progress",
    };
  }
  if (existingState?.status === "delivered") {
    return {
      status: "already-forwarded",
      canonicalIntentId: existingState.canonicalIntentId,
      reason: "already_delivered",
    };
  }

  const canonicalIntentId = buildRetryCanonicalIntentId(caseRecord.id, "atproto", requestId);
  const event = buildRetryCanonicalEvent(caseRecord, canonicalIntentId, observedAt);

  try {
    return await service.handleCanonicalEvent(event);
  } catch (error) {
    const updatedCase = await deps.store.getCase(caseRecord.id);
    const pendingState = updatedCase?.forwarding?.atproto;
    if (pendingState?.status === "pending" && pendingState.canonicalIntentId === canonicalIntentId) {
      return {
        status: "pending",
        canonicalIntentId,
        reason: "retryable_error",
      };
    }
    throw error;
  }
}

export async function handleIngestReportCreate(
  req: Request,
  options: {
    internalBridgeToken: string;
    canonicalPublisher?: CanonicalIntentPublisher;
    now?: () => string;
  },
): Promise<Response> {
  assertBearerToken(req.headers, options.internalBridgeToken);
  if (!options.canonicalPublisher) {
    throw internal("Canonical report publishing is not configured");
  }

  const body = await parseJson<ReportCreateRequestBody>(req);
  const caseId = sanitizeString(body.caseId, "caseId", 256);
  if (!caseId) {
    throw badRequest("caseId is required");
  }

  const reporterWebId = sanitizeString(body.reporterWebId, "reporterWebId", 2048) ?? null;
  const sourceAccountRef = validateActorRef(body.sourceAccountRef, "sourceAccountRef")
    ?? (reporterWebId ? { webId: reporterWebId } : undefined);
  if (!sourceAccountRef) {
    throw badRequest("sourceAccountRef or reporterWebId is required");
  }

  const createdAt = validateIsoDate(body.createdAt, "createdAt")
    ?? (options.now ? options.now() : new Date().toISOString());
  const observedAt = validateIsoDate(body.observedAt, "observedAt")
    ?? (options.now ? options.now() : new Date().toISOString());

  const intent: CanonicalReportCreateIntent = createCanonicalReportCreateIntent({
    sourceProtocol: "activitypods",
    sourceEventId: sanitizeString(body.sourceEventId, "sourceEventId", 512) ?? `activitypods:report:${caseId}`,
    sourceAccountRef,
    reporterWebId,
    subject: validateSubject(body.subject),
    reasonType: validateReasonType(body.reasonType),
    reason: sanitizeString(body.reason, "reason", 2_000) ?? null,
    evidenceObjectRefs: Array.isArray(body.evidenceObjectRefs)
      ? body.evidenceObjectRefs
        .map((entry, index) => validateObjectRef(entry, `evidenceObjectRefs[${index}]`))
        .filter((entry): entry is CanonicalObjectRef => Boolean(entry))
      : [],
    requestedForwarding: body.requestedForwarding
      ? { remote: Boolean(body.requestedForwarding.remote) }
      : null,
    clientContext: body.clientContext
      ? {
          app: sanitizeString(body.clientContext.app, "clientContext.app", 128) ?? null,
          surface: sanitizeString(body.clientContext.surface, "clientContext.surface", 128) ?? null,
        }
      : null,
    createdAt,
    observedAt,
  });

  await options.canonicalPublisher.publish(intent);

  return json({
    ok: true,
    canonicalIntentId: intent.canonicalIntentId,
  }, 202);
}

export async function handleRetryReportForwarding(
  req: Request,
  deps: ModerationBridgeDeps,
  options: {
    caseId: string;
    activityPubReportForwardingService?: Pick<ActivityPubReportForwardingService, "handleCanonicalEvent">;
    atprotoReportForwardingService?: Pick<AtprotoReportForwardingService, "handleCanonicalEvent">;
    now?: () => string;
  },
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:write");

  const caseId = sanitizeString(options.caseId, "caseId", 256);
  if (!caseId) {
    throw badRequest("caseId is required");
  }

  const caseRecord = await deps.store.getCase(caseId);
  if (!caseRecord) {
    throw notFound(`Case ${caseId} not found`);
  }
  if (caseRecord.source !== "local-user-report") {
    throw badRequest("Only local user report cases support remote forwarding retry");
  }
  if (!caseRecord.requestedForwarding?.remote) {
    throw badRequest("Remote forwarding has not been requested for this case");
  }

  const eligibleProtocols = determineEligibleRetryProtocols(caseRecord);
  if (eligibleProtocols.length === 0) {
    throw badRequest("This case does not have a remote authoritative protocol to forward");
  }

  const body = await parseOptionalJsonBody<ReportForwardingRetryRequestBody>(req);
  const protocols = normalizeRetryProtocols(body.protocols, eligibleProtocols);
  const unsupported = protocols.filter((protocol) => !eligibleProtocols.includes(protocol));
  if (unsupported.length > 0) {
    throw badRequest(`Protocol ${unsupported[0]} is not valid for this case`);
  }

  const requestId =
    sanitizeString(req.headers.get("x-request-id"), "x-request-id", 256)
    ?? `manual-forwarding-retry:${caseId}:${Date.now()}`;
  const observedAt = options.now ? options.now() : new Date().toISOString();
  const results: ReportForwardingRetryResponse = {};

  for (const protocol of protocols) {
    if (protocol === "activityPub") {
      if (!options.activityPubReportForwardingService) {
        throw internal("ActivityPub report forwarding service is not configured");
      }
      results.activityPub = await runActivityPubRetry(
        caseRecord,
        requestId,
        observedAt,
        deps,
        options.activityPubReportForwardingService,
      );
      continue;
    }

    if (!options.atprotoReportForwardingService) {
      throw internal("ATProto report forwarding service is not configured");
    }
    results.atproto = await runAtprotoRetry(
      caseRecord,
      requestId,
      observedAt,
      deps,
      options.atprotoReportForwardingService,
    );
  }

  return json({
    ok: true,
    caseId,
    results,
  }, 202);
}
