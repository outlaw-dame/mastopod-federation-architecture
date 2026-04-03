"use strict";

const {
  getActivityActorUri,
  normalizeUrl,
} = require("./activitypub-recipient-resolution");

const ACCEPT_HEADER = [
  "application/activity+json",
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
  "application/ld+json",
  "application/json",
].join(", ");

const ALLOWED_ACTIVITY_TYPES = new Set(["Like", "Announce", "Follow"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class ActivityResolutionError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "ActivityResolutionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function resolveRemoteActivity({
  activityId,
  expectedActorUri,
  timeoutMs,
  maxResponseBytes,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(activityId, {
      method: "GET",
      headers: {
        Accept: ACCEPT_HEADER,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ActivityResolutionError(
      "upstream_unavailable",
      `Failed to fetch remote activity: ${error?.message || String(error)}`,
      503,
    );
  }

  if (response.status === 404) {
    throw new ActivityResolutionError(
      "not_found",
      "Remote activity could not be resolved.",
      404,
    );
  }

  if (!response.ok) {
    throw new ActivityResolutionError(
      response.status === 429 || response.status >= 500
        ? "upstream_unavailable"
        : "resolution_failed",
      `Remote activity lookup returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500 ? 503 : 502,
    );
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !isAcceptedJsonContentType(contentType)) {
    throw new ActivityResolutionError(
      "invalid_content_type",
      "Remote activity did not return a supported JSON content type.",
      422,
    );
  }

  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength != null && declaredLength > maxResponseBytes) {
    throw new ActivityResolutionError(
      "payload_too_large",
      `Remote activity exceeded ${maxResponseBytes} bytes.`,
      422,
    );
  }

  const bodyText = await response.text();
  if (Buffer.byteLength(bodyText, "utf8") > maxResponseBytes) {
    throw new ActivityResolutionError(
      "payload_too_large",
      `Remote activity exceeded ${maxResponseBytes} bytes.`,
      422,
    );
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new ActivityResolutionError(
      "invalid_json",
      "Remote activity returned invalid JSON.",
      422,
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ActivityResolutionError(
      "invalid_payload",
      "Remote activity payload must be a JSON object.",
      422,
    );
  }

  const resolvedActivityId = normalizeUrl(payload.id || payload["@id"]);
  if (!resolvedActivityId || resolvedActivityId !== activityId) {
    throw new ActivityResolutionError(
      "activity_id_mismatch",
      "Resolved activity payload did not match the requested activityId.",
      422,
    );
  }

  const activityType = getActivityType(payload);
  if (!activityType || !ALLOWED_ACTIVITY_TYPES.has(activityType)) {
    throw new ActivityResolutionError(
      "unsupported_activity_type",
      "Resolved activity type is not supported for bridge Undo resolution.",
      422,
    );
  }

  const actorUri = normalizeUrl(getActivityActorUri(payload));
  if (!actorUri) {
    throw new ActivityResolutionError(
      "invalid_payload",
      "Resolved activity is missing a valid actor URI.",
      422,
    );
  }

  if (expectedActorUri && actorUri !== expectedActorUri) {
    throw new ActivityResolutionError(
      "actor_mismatch",
      "Resolved activity actor did not match the expected actor URI.",
      409,
    );
  }

  return sanitizePlainJsonObject(payload);
}

function getActivityType(payload) {
  if (typeof payload?.type === "string" && payload.type.trim()) {
    return payload.type.trim();
  }
  if (typeof payload?.["@type"] === "string" && payload["@type"].trim()) {
    return payload["@type"].trim();
  }
  return null;
}

function isAcceptedJsonContentType(contentType) {
  return (
    contentType.includes("application/activity+json") ||
    contentType.includes("application/ld+json") ||
    contentType.includes("application/json") ||
    /\bapplication\/[a-z0-9.+-]+\+json\b/.test(contentType)
  );
}

function parseContentLength(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sanitizePlainJsonObject(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => sanitizePlainJsonValue(entry)));
}

function sanitizePlainJsonValue(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePlainJsonValue(entry));
  }

  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      output[key] = sanitizePlainJsonValue(entry);
    }
    return output;
  }

  return null;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  ActivityResolutionError,
  parsePositiveInteger,
  resolveRemoteActivity,
};
