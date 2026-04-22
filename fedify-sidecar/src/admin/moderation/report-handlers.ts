import { assertBearerToken } from "../mrf/auth.js";
import { badRequest, internal } from "../mrf/errors.js";
import { json, parseJson } from "../mrf/utils.js";
import type { CanonicalIntentPublisher } from "../../protocol-bridge/canonical/CanonicalIntentPublisher.js";
import type { CanonicalActorRef } from "../../protocol-bridge/canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../../protocol-bridge/canonical/CanonicalObjectRef.js";
import type { CanonicalReportCreateIntent, CanonicalReportReasonType, CanonicalReportSubject } from "../../protocol-bridge/canonical/CanonicalIntent.js";
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
