import { assertAdminBearer } from "../mrf/auth.js";
import { badRequest, notFound } from "../mrf/errors.js";
import { json, parseJson } from "../mrf/utils.js";
import {
  ACTION_TO_AT_LABEL,
  ACTION_TO_MRF_FIELD,
  AT_GLOBAL_LABELS,
} from "./types.js";
import type {
  AtLabel,
  AtLabelPage,
  ModerationAction,
  ModerationBridgeDeps,
  ModerationDecision,
  ModerationDecisionPage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set<ModerationAction>(["label", "warn", "filter", "block", "suspend"]);

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

// ---------------------------------------------------------------------------
// POST /internal/admin/moderation/decisions
// Apply a cross-protocol moderation decision
// ---------------------------------------------------------------------------

interface ApplyDecisionBody {
  targetWebId?: string;
  targetAtDid?: string;
  targetHandle?: string;
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
  const targetAtDid = validateTargetAtDid(sanitise(body.targetAtDid, "targetAtDid"));
  const targetHandle = validateTargetHandle(sanitise(body.targetHandle, "targetHandle"));
  const reason = sanitise(body.reason, "reason", 500);

  // Must have at least one target identifier
  if (!targetWebId && !targetAtDid && !targetHandle) {
    throw badRequest("At least one of targetWebId, targetAtDid, or targetHandle must be provided");
  }

  // Build the resolved identities
  let resolvedWebId = targetWebId;
  let resolvedAtDid = targetAtDid;

  // Attempt to resolve missing identity half from the binding store
  if (resolvedWebId && !resolvedAtDid) {
    resolvedAtDid = (await deps.resolveAtDid(resolvedWebId)) ?? undefined;
  } else if (resolvedAtDid && !resolvedWebId) {
    resolvedWebId = (await deps.resolveWebId(resolvedAtDid)) ?? undefined;
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
    targetAtDid: resolvedAtDid,
    targetHandle: targetHandle ?? extractHandleFromTarget(resolvedWebId, resolvedAtDid),
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
  // 1. Propagate to ActivityPub (MRF content-policy module)
  // ------------------------------------------------------------------
  const mrfField = ACTION_TO_MRF_FIELD[body.action];
  let mrfPatched = false;

  if (mrfField) {
    const targetIdentifier = resolvedWebId || resolvedAtDid || targetHandle;
    if (targetIdentifier) {
      try {
        // Read current module config so we append labels instead of replacing
        // the entire blockedLabels/warnLabels list.
        let mergedLabels = allLabels;
        const currentResponse = await retry(() =>
          deps.mrfInternalFetch({
            method: "GET",
            path: "/internal/admin/mrf/modules/content-policy",
            permission: "provider:read",
            actorWebId: actor,
          }),
        );

        if (!currentResponse.ok) {
          throw new Error("Unable to fetch existing content-policy module config");
        }

        const currentJson = await currentResponse.json().catch(() => null) as {
          data?: { config?: { config?: { blockedLabels?: string[]; warnLabels?: string[] } } };
        } | null;
        const existing = currentJson?.data?.config?.config?.[mrfField] || [];
        mergedLabels = [...new Set([...existing, ...allLabels])].slice(0, 200);

        const mrfBody = { [mrfField]: mergedLabels };
        const mrfResponse = await retry(() =>
          deps.mrfInternalFetch({
            method: "PATCH",
            path: "/internal/admin/mrf/modules/content-policy",
            body: mrfBody,
            permission: "provider:write",
            actorWebId: actor,
          }),
        );
        mrfPatched = mrfResponse.ok;
      } catch {
        // MRF patch is best-effort — decision is persisted regardless
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Propagate to ATProto (emit AT label for each target DID)
  // ------------------------------------------------------------------
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
  // 3. Update protocol propagation status and persist
  // ------------------------------------------------------------------
  const protocols: ModerationDecision["protocols"] =
    mrfPatched && atLabelEmitted ? "both" :
    mrfPatched ? "ap" :
    atLabelEmitted ? "at" : "none";

  const persisted: ModerationDecision = {
    ...decision,
    mrfPatched,
    atLabelEmitted,
    atStatusUpdated,
    protocols,
  };

  await deps.store.addDecision(persisted);

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
  const includeRevoked = params["includeRevoked"] !== "false";

  const page: ModerationDecisionPage = await deps.store.listDecisions({
    limit,
    cursor,
    action,
    targetAtDid,
    targetWebId,
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

  const safeId = sanitiseId(id);
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
  const safeId = sanitiseId(id);

  const decision = await deps.store.getDecision(safeId);
  if (!decision) throw notFound(`Decision ${safeId} not found`);
  if (decision.revoked) {
    return json({ decision, ok: true, message: "Already revoked" });
  }

  // ------------------------------------------------------------------
  // 1. Negate AT labels for the target DID
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

  // ------------------------------------------------------------------
  // 2. Note: We do NOT automatically remove labels from MRF
  //    content-policy.blockedLabels because the same label string may
  //    have been added by multiple decisions. A dedicated MRF module
  //    reconciliation pass would be needed for cleanup.
  //    The UI shows a warning for this case.
  // ------------------------------------------------------------------

  const updated = await deps.store.patchDecision(safeId, {
    revoked: true,
    revokedAt: deps.now(),
    revokedBy: actor,
  });

  return json({ decision: updated, ok: true });
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

function sanitiseId(id: string): string {
  // ULID: 26 chars, URL-safe base32
  const cleaned = id.trim();
  if (!/^[0-9A-Z]{26}$/i.test(cleaned)) {
    throw badRequest("Invalid decision id format");
  }
  return cleaned.toUpperCase();
}

function extractHandleFromTarget(
  webId: string | undefined,
  atDid: string | undefined,
): string | undefined {
  if (atDid) {
    const match = atDid.match(/did:web:(.+)/);
    if (match) return match[1];
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
