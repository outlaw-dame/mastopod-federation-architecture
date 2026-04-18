import { sanitizeJsonObject, type SafeJsonValue } from "../../utils/safe-json.js";

const SMITHEREEN_CONTEXT = {
  sm: "http://smithereen.software/ns#",
  ActorStatus: "sm:ActorStatus",
  status: {
    "@type": "@id",
    "@id": "sm:status",
  },
  statusHistory: {
    "@type": "@id",
    "@id": "sm:statusHistory",
  },
} as const;

type SafeJsonRecord = Record<string, SafeJsonValue>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function normalizeTimestamp(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function sanitizeAttachment(value: unknown): SafeJsonRecord | undefined {
  if (value == null) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  try {
    return sanitizeJsonObject(record, {
      maxDepth: 6,
      maxNodes: 200,
      maxBytes: 8_192,
      maxArrayLength: 32,
      maxObjectKeys: 32,
    });
  } catch {
    return undefined;
  }
}

function sanitizeActorStatus(
  value: unknown,
  actorId: string,
  options: { now?: Date; suppressExpired?: boolean } = {},
): SafeJsonRecord | null {
  const status = asRecord(value);
  if (!status) {
    return null;
  }

  const content = asString(status["content"]);
  const published = normalizeTimestamp(status["published"]);
  const id = asString(status["id"] ?? status["@id"]);
  if (!content || !published || !id) {
    return null;
  }

  const endTime = normalizeTimestamp(status["endTime"]);
  if (options.suppressExpired !== false && endTime) {
    const nowMs = (options.now ?? new Date()).getTime();
    if (new Date(endTime).getTime() <= nowMs) {
      return null;
    }
  }

  const attachment = sanitizeAttachment(status["attachment"]);

  return {
    type: "ActorStatus",
    id,
    attributedTo: actorId,
    content,
    published,
    ...(endTime ? { endTime } : {}),
    ...(attachment ? { attachment } : {}),
  };
}

function hasActorStatusHistory(value: unknown): boolean {
  return value != null;
}

function contextIncludesActorStatusTerms(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => contextIncludesActorStatusTerms(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return (
    record["sm"] === SMITHEREEN_CONTEXT.sm ||
    Object.prototype.hasOwnProperty.call(record, "status") ||
    Object.prototype.hasOwnProperty.call(record, "statusHistory") ||
    Object.prototype.hasOwnProperty.call(record, "ActorStatus")
  );
}

function withActorStatusContext(record: Record<string, unknown>): Record<string, unknown> {
  if (contextIncludesActorStatusTerms(record["@context"])) {
    return record;
  }

  const existingContext = record["@context"];
  if (Array.isArray(existingContext)) {
    return {
      ...record,
      "@context": [...existingContext, SMITHEREEN_CONTEXT],
    };
  }

  if (existingContext != null) {
    return {
      ...record,
      "@context": [existingContext, SMITHEREEN_CONTEXT],
    };
  }

  return {
    ...record,
    "@context": ["https://www.w3.org/ns/activitystreams", SMITHEREEN_CONTEXT],
  };
}

export function withActorStatusProperties(
  actorUrl: string,
  payload: unknown,
  sourceActor: unknown,
  now: Date = new Date(),
): string {
  const actorRecord = asRecord(payload);
  const sourceRecord = asRecord(sourceActor);
  if (!actorRecord || !sourceRecord) {
    return JSON.stringify(payload);
  }

  const nextRecord: Record<string, unknown> = { ...actorRecord };
  const currentStatus = sanitizeActorStatus(sourceRecord["status"], actorUrl, {
    now,
    suppressExpired: true,
  });
  const hasHistory = hasActorStatusHistory(sourceRecord["statusHistory"]);

  if (currentStatus) {
    nextRecord["status"] = currentStatus;
  } else {
    delete nextRecord["status"];
  }

  if (hasHistory) {
    nextRecord["statusHistory"] = `${actorUrl}/statusHistory`;
  } else {
    delete nextRecord["statusHistory"];
  }

  const enriched = currentStatus || hasHistory ? withActorStatusContext(nextRecord) : nextRecord;
  return JSON.stringify(enriched);
}

export function buildActorStatusHistoryCollection(
  actorUrl: string,
  collectionUrl: string,
  payload: unknown,
  now: Date = new Date(),
): Record<string, unknown> {
  const source = asRecord(payload);
  const rawItems = Array.isArray(source?.["orderedItems"])
    ? (source?.["orderedItems"] as unknown[])
    : Array.isArray(source?.["items"])
      ? (source?.["items"] as unknown[])
      : Array.isArray(payload)
        ? payload
        : [];

  const orderedItems = rawItems
    .map((item) =>
      sanitizeActorStatus(item, actorUrl, {
        now,
        suppressExpired: false,
      }),
    )
    .filter((item): item is SafeJsonRecord => item != null);

  return withActorStatusContext({
    id: collectionUrl,
    type: "OrderedCollection",
    totalItems: orderedItems.length,
    orderedItems,
  });
}
