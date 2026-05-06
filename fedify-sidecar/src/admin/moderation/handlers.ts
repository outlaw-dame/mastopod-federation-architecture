import { assertAdminBearer } from "../mrf/auth.js";
import { badRequest, internal, notFound } from "../mrf/errors.js";
import { json, parseJson } from "../mrf/utils.js";
import {
  activityPubSubjectPolicyRegistration,
  type ActivityPubSubjectPolicyConfig,
  type ActivityPubSubjectRule,
} from "../mrf/registry/modules/activitypub-subject-policy.js";
import {
  ACTION_TO_AT_LABEL,
  AT_GLOBAL_LABELS,
} from "./types.js";
import { sanitizeDomain } from "../../delivery/DomainReputationStore.js";
import type {
  AtLabel,
  AtLabelPage,
  DomainBlockSeverity,
  ModerationAction,
  ModerationBridgeDeps,
  ModerationCasePage,
  ModerationCaseStatus,
  ModerationDecision,
  ModerationDecisionPage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set<ModerationAction>(["label", "warn", "filter", "block", "suspend"]);
const DOMAIN_BLOCK_SEVERITIES = new Set<DomainBlockSeverity>(["noop", "silence", "suspend"]);
const SUBJECT_POLICY_MODULE_ID = "activitypub-subject-policy";
const AP_RULE_ACTION_BY_DECISION: Partial<Record<ModerationAction, "filter" | "reject">> = {
  filter: "filter",
  block: "reject",
  suspend: "reject",
};
const AP_RULE_ACTION_BY_DOMAIN_SEVERITY: Partial<Record<DomainBlockSeverity, "filter" | "reject">> = {
  silence: "filter",
  suspend: "reject",
};

const DID_PATTERN = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/;
const HANDLE_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

function isValidLabelValue(val: string): boolean {
  if (!val || typeof val !== "string") return false;
  if (val.length > 128) return false;
  // AT labels: printable ASCII, no whitespace, starting with letter, digit, or !
  return /^[a-zA-Z0-9!][a-zA-Z0-9!._-]*$/.test(val);
}

function validateLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const labels = raw.filter((v): v is string => typeof v === "string" && isValidLabelValue(v));
  return [...new Set(labels)].slice(0, 20);
}

function sanitise(value: unknown, field: string, maxLen = 2048): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLen) throw badRequest(`${field} exceeds maximum length`);
  return trimmed || undefined;
}

function validateTargetWebId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw badRequest("targetWebId must use http or https");
    }
    return url.toString();
  } catch {
    throw badRequest("targetWebId must be a valid URL");
  }
}

function validateTargetAtDid(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!DID_PATTERN.test(value)) {
    throw badRequest("targetAtDid is not a valid DID");
  }
  return value;
}

function validateTargetHandle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!HANDLE_PATTERN.test(value)) {
    throw badRequest("targetHandle is not a valid handle");
  }
  return value;
}

function validateTargetActorUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw badRequest("targetActorUri must use http or https");
    }
    url.hash = "";
    return url.toString();
  } catch {
    throw badRequest("targetActorUri must be a valid URL");
  }
}

function validateTargetDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = sanitizeDomain(value);
  if (!normalized) {
    throw badRequest("targetDomain must be a valid hostname");
  }
  return normalized;
}

function validateDomainBlockSeverity(value: unknown): DomainBlockSeverity | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw badRequest("domainBlockSeverity must be a string");
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_BLOCK_SEVERITIES.has(normalized as DomainBlockSeverity)) {
    throw badRequest(`domainBlockSeverity must be one of: ${[...DOMAIN_BLOCK_SEVERITIES].join(", ")}`);
  }
  return normalized as DomainBlockSeverity;
}

function validateBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw badRequest(`${field} must be a boolean`);
}

async function retry<T>(
  operation: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1_500;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = Math.floor(Math.random() * Math.max(25, Math.floor(delay / 3)));
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSubjectPolicyRule(params: {
  decisionId: string;
  action: ModerationAction;
  domainBlockSeverity?: DomainBlockSeverity;
  targetActorUri?: string;
  targetWebId?: string;
  targetDomain?: string;
  reason?: string;
  actor: string;
  createdAt: string;
}): ActivityPubSubjectRule | null {
  const apAction = params.targetDomain && params.domainBlockSeverity
    ? AP_RULE_ACTION_BY_DOMAIN_SEVERITY[params.domainBlockSeverity]
    : AP_RULE_ACTION_BY_DECISION[params.action];
  if (!apAction) {
    return null;
  }
  if (!params.targetActorUri && !params.targetWebId && !params.targetDomain) {
    return null;
  }

  return {
    id: params.decisionId,
    action: apAction,
    ...(params.targetActorUri ? { actorUri: params.targetActorUri } : {}),
    ...(params.targetWebId ? { webId: params.targetWebId } : {}),
    ...(params.targetDomain ? { domain: params.targetDomain } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    createdAt: params.createdAt,
    createdBy: params.actor,
  };
}

async function readSubjectPolicyModule(
  deps: ModerationBridgeDeps,
): Promise<{
  enabled: boolean;
  mode: string;
  revision: number;
  config: ActivityPubSubjectPolicyConfig;
}> {
  const response = await deps.mrfInternalFetch({
    method: "GET",
    path: `/internal/admin/mrf/modules/${SUBJECT_POLICY_MODULE_ID}`,
    permission: "provider:read",
  });
  if (!response.ok) {
    throw new Error(`Failed to load ${SUBJECT_POLICY_MODULE_ID} module (${response.status})`);
  }

  const payload = await response.json() as { data?: { config?: unknown } };
  const moduleConfig = payload?.data?.config;
  if (!isRecord(moduleConfig)) {
    throw new Error(`Malformed ${SUBJECT_POLICY_MODULE_ID} module response`);
  }

  const revision = typeof moduleConfig["revision"] === "number" ? moduleConfig["revision"] : 0;
  const enabled = moduleConfig["enabled"] !== false;
  const mode = typeof moduleConfig["mode"] === "string" ? moduleConfig["mode"] : "enforce";
  const rawConfig = isRecord(moduleConfig["config"]) ? moduleConfig["config"] : {};
  const normalized = activityPubSubjectPolicyRegistration.validateAndNormalizeConfig(rawConfig, {
    existingConfig: activityPubSubjectPolicyRegistration.getDefaultConfig(),
    partial: true,
  });

  return {
    enabled,
    mode,
    revision,
    config: normalized.config as ActivityPubSubjectPolicyConfig,
  };
}

async function upsertSubjectPolicyRule(
  deps: ModerationBridgeDeps,
  rule: ActivityPubSubjectRule,
  actor: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readSubjectPolicyModule(deps);
    const rules = [
      ...current.config.rules.filter((entry) => entry.id !== rule.id),
      rule,
    ];

    const response = await deps.mrfInternalFetch({
      method: "PATCH",
      path: `/internal/admin/mrf/modules/${SUBJECT_POLICY_MODULE_ID}`,
      permission: "provider:write",
      actorWebId: actor,
      body: {
        enabled: true,
        mode: "enforce",
        config: { rules },
        expectedRevision: current.revision,
      },
    });

    if (response.status === 409) {
      continue;
    }

    return response.ok;
  }

  return false;
}

async function removeSubjectPolicyRule(
  deps: ModerationBridgeDeps,
  ruleId: string,
  actor: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readSubjectPolicyModule(deps);
    const rules = current.config.rules.filter((entry) => entry.id !== ruleId);

    const response = await deps.mrfInternalFetch({
      method: "PATCH",
      path: `/internal/admin/mrf/modules/${SUBJECT_POLICY_MODULE_ID}`,
      permission: "provider:write",
      actorWebId: actor,
      body: {
        config: { rules },
        expectedRevision: current.revision,
      },
    });

    if (response.status === 409) {
      continue;
    }

    return response.ok;
  }

  return false;
}

// ---------------------------------------------------------------------------
// POST /internal/admin/moderation/decisions
// Apply a cross-protocol moderation decision
// ---------------------------------------------------------------------------

interface ApplyDecisionBody {
  targetWebId?: string;
  targetActorUri?: string;
  targetAtDid?: string;
  targetHandle?: string;
  targetDomain?: string;
  domainBlockSeverity?: string;
  targetDomainSeverity?: string;
  severity?: string;
  rejectMedia?: boolean | string;
  rejectReports?: boolean | string;
  privateComment?: string;
  publicComment?: string;
  obfuscate?: boolean | string;
  sourceCaseId?: string;
  action: ModerationAction;
  labels?: string[];
  reason?: string;
}

export async function handleApplyDecision(
  req: Request,
  deps: ModerationBridgeDeps,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:write");

  const actor = deps.actorFromRequest(req);
  const body = await parseJson<ApplyDecisionBody>(req);

  // Validate action
  if (!VALID_ACTIONS.has(body.action)) {
    throw badRequest(`Invalid action '${body.action}'. Must be one of: ${[...VALID_ACTIONS].join(", ")}`);
  }

  const targetWebId = validateTargetWebId(sanitise(body.targetWebId, "targetWebId"));
  const targetActorUri = validateTargetActorUri(sanitise(body.targetActorUri, "targetActorUri"));
  const targetAtDid = validateTargetAtDid(sanitise(body.targetAtDid, "targetAtDid"));
  const targetHandle = validateTargetHandle(sanitise(body.targetHandle, "targetHandle"));
  const targetDomain = validateTargetDomain(sanitise(body.targetDomain, "targetDomain"));
  const domainBlockSeverity = targetDomain
    ? validateDomainBlockSeverity(body.domainBlockSeverity ?? body.targetDomainSeverity ?? body.severity)
    : undefined;
  const rejectMedia = targetDomain ? validateBoolean(body.rejectMedia, "rejectMedia") : undefined;
  const rejectReports = targetDomain ? validateBoolean(body.rejectReports, "rejectReports") : undefined;
  const privateComment = targetDomain ? sanitise(body.privateComment, "privateComment", 500) : undefined;
  const publicComment = targetDomain ? sanitise(body.publicComment, "publicComment", 500) : undefined;
  const obfuscate = targetDomain ? validateBoolean(body.obfuscate, "obfuscate") : undefined;
  const sourceCaseId = body.sourceCaseId ? sanitiseRecordId(body.sourceCaseId, "case") : undefined;
  const reason = sanitise(body.reason, "reason", 500);

  // Must have at least one target identifier
  if (!targetWebId && !targetActorUri && !targetAtDid && !targetHandle && !targetDomain) {
    throw badRequest(
      "At least one of targetWebId, targetActorUri, targetAtDid, targetHandle, or targetDomain must be provided",
    );
  }

  const linkedCase = sourceCaseId ? await deps.store.getCase(sourceCaseId) : null;
  if (sourceCaseId && !linkedCase) {
    throw notFound(`Case ${sourceCaseId} not found`);
  }

  // Build the resolved identities
  let resolvedWebId = targetWebId;
  let resolvedActorUri = targetActorUri;
  let resolvedAtDid = targetAtDid;

  // Attempt to resolve missing identity half from the binding store
  if (resolvedWebId && !resolvedAtDid) {
    resolvedAtDid = (await deps.resolveAtDid(resolvedWebId)) ?? undefined;
  } else if (resolvedAtDid && !resolvedWebId) {
    resolvedWebId = (await deps.resolveWebId(resolvedAtDid)) ?? undefined;
  }
  if (resolvedWebId && !resolvedActorUri) {
    resolvedActorUri = (await deps.resolveActivityPubActorUri(resolvedWebId)) ?? undefined;
  }

  // Determine labels to emit
  const primaryLabel = ACTION_TO_AT_LABEL[body.action];
  const extraLabels = validateLabels(body.labels ?? []).filter(v => v !== primaryLabel);
  const allLabels = [primaryLabel, ...extraLabels];

  const now = deps.now();
  const id = deps.uuid();

  const decision: ModerationDecision = {
    id,
    source: "provider-dashboard",
    targetWebId: resolvedWebId,
    targetActorUri: resolvedActorUri,
    targetAtDid: resolvedAtDid,
    targetHandle: targetHandle ?? extractHandleFromTarget(resolvedWebId, resolvedActorUri, resolvedAtDid),
    targetDomain,
    ...(domainBlockSeverity ? { domainBlockSeverity } : {}),
    ...(rejectMedia !== undefined ? { rejectMedia } : {}),
    ...(rejectReports !== undefined ? { rejectReports } : {}),
    ...(privateComment ? { privateComment } : {}),
    ...(publicComment ? { publicComment } : {}),
    ...(obfuscate !== undefined ? { obfuscate } : {}),
    ...(sourceCaseId ? { sourceCaseId } : {}),
    action: body.action,
    labels: allLabels,
    reason,
    appliedBy: actor,
    appliedAt: now,
    protocols: "none",
    mrfPatched: false,
    atLabelEmitted: false,
    atStatusUpdated: false,
    revoked: false,
  };

  // ------------------------------------------------------------------
  // 1. Propagate to ATProto (emit AT label for each target DID)
  // ------------------------------------------------------------------
  let mrfPatched = false;
  let apPatchAttempted = false;
  let atLabelEmitted = false;
  let atStatusUpdated = false;

  if (resolvedAtDid) {
    try {
      for (const labelVal of allLabels) {
        await retry(() =>
          deps.labelEmitter.emit({
            uri: resolvedAtDid,
            val: labelVal,
            reason,
          }),
        );
      }
      atLabelEmitted = true;
    } catch {
      // Label emission is best-effort
    }

    if (body.action === "suspend" && deps.updateAtSubjectStatus) {
      try {
        atStatusUpdated = await retry(() =>
          deps.updateAtSubjectStatus!({
            did: resolvedAtDid!,
            reason,
          }),
        );
      } catch {
        atStatusUpdated = false;
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Propagate to ActivityPub subject policy when the action is enforceable
  // ------------------------------------------------------------------
  const subjectRule = buildSubjectPolicyRule({
    decisionId: id,
    action: body.action,
    domainBlockSeverity,
    targetActorUri: resolvedActorUri,
    targetWebId: resolvedWebId,
    targetDomain,
    reason,
    actor,
    createdAt: now,
  });
  if (subjectRule) {
    apPatchAttempted = true;
    try {
      mrfPatched = await upsertSubjectPolicyRule(deps, subjectRule, actor);
    } catch {
      mrfPatched = false;
    }
  }

  // ------------------------------------------------------------------
  // 3. Update protocol propagation status and persist
  // ------------------------------------------------------------------
  if (apPatchAttempted && !mrfPatched && !atLabelEmitted) {
    throw internal("Failed to apply moderation to ActivityPub and no AT Protocol label was emitted");
  }

  const protocols: ModerationDecision["protocols"] =
    mrfPatched && atLabelEmitted
      ? "both"
      : mrfPatched
        ? "ap"
        : atLabelEmitted
          ? "at"
          : "none";

  const persisted: ModerationDecision = {
    ...decision,
    mrfPatched,
    atLabelEmitted,
    atStatusUpdated,
    protocols,
  };

  await deps.store.addDecision(persisted);

  if (sourceCaseId && linkedCase) {
    const relatedDecisionIds = [...new Set([...(linkedCase.relatedDecisionIds || []), persisted.id])];
    await deps.store.patchCase(sourceCaseId, {
      status: "resolved",
      relatedDecisionIds,
      updatedAt: now,
      resolvedAt: now,
      resolvedBy: actor,
    });
  }

  return json({ decision: persisted, ok: true }, 201);
}

// ---------------------------------------------------------------------------
// GET /internal/admin/moderation/decisions
// List cross-protocol moderation decisions
// ---------------------------------------------------------------------------

export async function handleListDecisions(
  req: Request,
  deps: ModerationBridgeDeps,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const params = parseQuery(req.url);
  const limit = Math.min(Number(params["limit"]) || 50, 200);
  const cursor = params["cursor"] || undefined;
  const action = params["action"] as ModerationAction | undefined;
  const targetAtDid = params["targetAtDid"] || undefined;
  const targetWebId = params["targetWebId"] || undefined;
  const targetActorUri = params["targetActorUri"] || undefined;
  const targetDomain = params["targetDomain"] || undefined;
  const domainBlockSeverity = validateDomainBlockSeverity(params["domainBlockSeverity"]);
  const includeRevoked = params["includeRevoked"] !== "false";

  const page: ModerationDecisionPage = await deps.store.listDecisions({
    limit,
    cursor,
    action,
    targetAtDid,
    targetWebId,
    targetActorUri,
    targetDomain,
    domainBlockSeverity,
    includeRevoked,
  });

  return json(page);
}

// ---------------------------------------------------------------------------
// GET /internal/admin/moderation/decisions/:id
// Get a single decision
// ---------------------------------------------------------------------------

export async function handleGetDecision(
  req: Request,
  deps: ModerationBridgeDeps,
  id: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const safeId = sanitiseRecordId(id, "decision");
  const decision = await deps.store.getDecision(safeId);
  if (!decision) throw notFound(`Decision ${safeId} not found`);

  return json({ decision });
}

// ---------------------------------------------------------------------------
// DELETE /internal/admin/moderation/decisions/:id
// Revoke a decision (emits negation AT labels, removes from MRF if possible)
// ---------------------------------------------------------------------------

export async function handleRevokeDecision(
  req: Request,
  deps: ModerationBridgeDeps,
  id: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:write");

  const actor = deps.actorFromRequest(req);
  const safeId = sanitiseRecordId(id, "decision");

  const decision = await deps.store.getDecision(safeId);
  if (!decision) throw notFound(`Decision ${safeId} not found`);
  if (decision.revoked) {
    return json({ decision, ok: true, message: "Already revoked" });
  }

  // ------------------------------------------------------------------
  // 1. Remove the exact ActivityPub subject rule before we mark the decision
  //    revoked. Rules are keyed by decision id, so duplicate decisions are safe.
  // ------------------------------------------------------------------
  if (decision.mrfPatched) {
    const removed = await removeSubjectPolicyRule(deps, decision.id, actor);
    if (!removed) {
      throw internal("Failed to revoke ActivityPub subject policy rule");
    }
  }

  // ------------------------------------------------------------------
  // 2. Negate AT labels for the target DID
  // ------------------------------------------------------------------
  if (decision.targetAtDid && decision.atLabelEmitted) {
    for (const labelVal of decision.labels) {
      try {
        await retry(() => deps.labelEmitter.negate(decision.targetAtDid!, labelVal));
      } catch {
        // best-effort
      }
    }
  }

  const updated = await deps.store.patchDecision(safeId, {
    revoked: true,
    revokedAt: deps.now(),
    revokedBy: actor,
  });

  if (decision.sourceCaseId) {
    const moderationCase = await deps.store.getCase(decision.sourceCaseId);
    if (moderationCase) {
      const remainingRelated = [];
      for (const relatedId of moderationCase.relatedDecisionIds || []) {
        const relatedDecision = await deps.store.getDecision(relatedId);
        if (relatedDecision && !relatedDecision.revoked && relatedDecision.id !== decision.id) {
          remainingRelated.push(relatedDecision.id);
        }
      }

      await deps.store.patchCase(decision.sourceCaseId, {
        status: remainingRelated.length > 0 ? "resolved" : "open",
        updatedAt: deps.now(),
        resolvedAt: remainingRelated.length > 0 ? moderationCase.resolvedAt ?? deps.now() : undefined,
        resolvedBy: remainingRelated.length > 0 ? moderationCase.resolvedBy : undefined,
      });
    }
  }

  return json({ decision: updated, ok: true });
}

// ---------------------------------------------------------------------------
// GET /internal/admin/moderation/cases
// List inbound moderation cases
// ---------------------------------------------------------------------------

export async function handleListCases(
  req: Request,
  deps: ModerationBridgeDeps,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const params = parseQuery(req.url);
  const limit = Math.min(Number(params["limit"]) || 50, 200);
  const cursor = params["cursor"] || undefined;
  const status = validateCaseStatus(params["status"]);
  const source = validateCaseSource(params["source"]);
  const sourceActorUri = params["sourceActorUri"] || undefined;
  const recipientWebId = params["recipientWebId"] || undefined;
  const reportedActorUri = params["reportedActorUri"] || undefined;

  const page: ModerationCasePage = await deps.store.listCases({
    limit,
    cursor,
    status,
    source,
    sourceActorUri,
    recipientWebId,
    reportedActorUri,
  });

  return json(page);
}

// ---------------------------------------------------------------------------
// GET /internal/admin/moderation/cases/:id
// Get a single moderation case
// ---------------------------------------------------------------------------

export async function handleGetCase(
  req: Request,
  deps: ModerationBridgeDeps,
  id: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const safeId = sanitiseRecordId(id, "case");
  const moderationCase = await deps.store.getCase(safeId);
  if (!moderationCase) throw notFound(`Case ${safeId} not found`);

  return json({ case: moderationCase });
}

// ---------------------------------------------------------------------------
// GET /internal/admin/moderation/labels
// List AT labels emitted by our labeler service
// ---------------------------------------------------------------------------

export async function handleListAtLabels(
  req: Request,
  deps: ModerationBridgeDeps,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const params = parseQuery(req.url);
  const limit = Math.min(Number(params["limit"]) || 100, 500);
  const cursor = params["cursor"] ? Number(params["cursor"]) : 0;
  const subject = params["subject"] || undefined;

  const page: AtLabelPage = await deps.store.listAtLabels({ limit, cursor, subject });

  return json(page);
}

// ---------------------------------------------------------------------------
// GET /xrpc/com.atproto.label.queryLabels
// AT Protocol XRPC endpoint for external consumers (Bluesky apps)
//
// Ref: https://atproto.com/lexicons/com-atproto-label#com-atproto-label-query-labels
// ---------------------------------------------------------------------------

export async function handleXrpcQueryLabels(
  req: Request,
  deps: ModerationBridgeDeps,
): Promise<Response> {
  // This endpoint is public (no bearer auth) — Bluesky clients call it directly.
  // Rate limiting is applied at the Fastify route level.

  const params = parseQuery(req.url);
  const uriPatterns = params["uriPatterns"] ? params["uriPatterns"].split(",").slice(0, 20) : undefined;
  const sources = params["sources"] ? params["sources"].split(",").slice(0, 20) : undefined;
  const limit = Math.min(Number(params["limit"]) || 50, 250);
  const cursor = params["cursor"] ? Number(params["cursor"]) : 0;

  // If uriPatterns provided, query each subject individually and merge
  const sub = uriPatterns?.[0];
  const page: AtLabelPage = await deps.store.listAtLabels({
    limit,
    cursor,
    subject: sub,
  });

  // Filter by sources if provided (our labeler DID must be in sources)
  // In practice we only serve our own labels here
  const labels = sources && sources.length > 0
    ? page.labels.filter(l => sources.includes(l.src))
    : page.labels;

  // AT XRPC response format
  return json({
    cursor: page.cursor > 0 ? String(page.cursor) : undefined,
    labels: labels.map(normaliseAtLabel),
  });
}

// ---------------------------------------------------------------------------
// GET /internal/admin/moderation/at-labels/known
// Return the known AT global labels for the frontend label picker
// ---------------------------------------------------------------------------

export async function handleListKnownAtLabels(
  req: Request,
  deps: ModerationBridgeDeps,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  return json({
    globalLabels: [...AT_GLOBAL_LABELS],
    actionDefaults: Object.fromEntries(
      Object.entries(ACTION_TO_AT_LABEL).map(([action, label]) => [action, label]),
    ),
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseQuery(url: string): Record<string, string> {
  try {
    const u = new URL(url);
    return Object.fromEntries(u.searchParams.entries());
  } catch {
    return {};
  }
}

function sanitiseRecordId(id: string, kind: "decision" | "case" = "decision"): string {
  const cleaned = id.trim();
  const decisionId = /^[0-9A-Z]{26}$/i.test(cleaned);
  const caseId = /^[a-z0-9._:-]{16,128}$/i.test(cleaned);
  if (!decisionId && !caseId) {
    throw badRequest(`Invalid ${kind} id format`);
  }
  return decisionId ? cleaned.toUpperCase() : cleaned;
}

function validateCaseStatus(value: string | undefined): ModerationCaseStatus | undefined {
  if (!value) return undefined;
  if (value === "open" || value === "resolved" || value === "dismissed") {
    return value;
  }
  throw badRequest("Invalid case status");
}

function validateCaseSource(value: string | undefined): "activitypub-flag" | "local-user-report" | undefined {
  if (!value) return undefined;
  if (value === "activitypub-flag" || value === "local-user-report") {
    return value;
  }
  throw badRequest("Invalid case source");
}

function extractHandleFromTarget(
  webId: string | undefined,
  actorUri: string | undefined,
  atDid: string | undefined,
): string | undefined {
  if (atDid) {
    const match = atDid.match(/did:web:(.+)/);
    if (match) return match[1];
  }
  if (actorUri) {
    try {
      const u = new URL(actorUri);
      return u.hostname + (u.pathname !== "/" ? u.pathname : "");
    } catch {
      return undefined;
    }
  }
  if (webId) {
    try {
      const u = new URL(webId);
      return u.hostname + (u.pathname !== "/" ? u.pathname : "");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Serialise an AtLabel for XRPC response — convert sig buffer to base64url string. */
function normaliseAtLabel(label: AtLabel): Record<string, unknown> {
  const out: Record<string, unknown> = { ...label };
  if (label["sig"] instanceof Uint8Array) {
    out["sig"] = Buffer.from(label["sig"]).toString("base64url");
  }
  return out;
}
