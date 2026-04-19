const TOOT_NS = "http://joinmastodon.org/ns#";

export const TOOT_ATTRIBUTION_DOMAINS_IRI = `${TOOT_NS}attributionDomains`;
export const TOOT_ATTRIBUTION_DOMAINS_SHORT = "toot:attributionDomains";
export const TOOT_AUTHOR_ATTRIBUTION_CONTEXT = {
  toot: TOOT_NS,
  attributionDomains: TOOT_ATTRIBUTION_DOMAINS_SHORT,
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value != null ? [value] : [];
}

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed.replace(/^\/+/, "")}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || !parsed.hostname) {
    return null;
  }

  return parsed.hostname.toLowerCase().replace(/\.+$/, "") || null;
}

export function getAttributionDomains(actor: unknown): string[] {
  const record = asRecord(actor);
  if (!record) {
    return [];
  }

  const raw =
    record["attributionDomains"]
    ?? record[TOOT_ATTRIBUTION_DOMAINS_IRI]
    ?? record[TOOT_ATTRIBUTION_DOMAINS_SHORT];

  return [...new Set(
    toArray(raw)
      .map((value) => normalizeDomain(value))
      .filter((value): value is string => value != null),
  )];
}

export function isAuthorizedAttributionDomain(
  hostname: string | null | undefined,
  attributionDomains: readonly string[],
): boolean {
  if (!hostname) {
    return false;
  }

  const normalizedHost = normalizeDomain(hostname);
  if (!normalizedHost) {
    return false;
  }

  return attributionDomains.some((domain) =>
    normalizedHost === domain || normalizedHost.endsWith(`.${domain}`),
  );
}

function contextIncludesAuthorAttributionTerms(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => contextIncludesAuthorAttributionTerms(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return (
    record["attributionDomains"] === TOOT_ATTRIBUTION_DOMAINS_SHORT ||
    record["attributionDomains"] === TOOT_ATTRIBUTION_DOMAINS_IRI
  );
}

function withContextEntry(record: Record<string, unknown>, entry: unknown): Record<string, unknown> {
  const existingContext = record["@context"];
  if (Array.isArray(existingContext)) {
    return { ...record, "@context": [...existingContext, entry] };
  }
  if (existingContext != null) {
    return { ...record, "@context": [existingContext, entry] };
  }
  return {
    ...record,
    "@context": ["https://www.w3.org/ns/activitystreams", entry],
  };
}

export function withNormalizedAttributionDomains(
  payload: unknown,
  sourceActor: unknown,
): string {
  const actorRecord = asRecord(payload);
  const sourceRecord = asRecord(sourceActor);
  if (!actorRecord || !sourceRecord) {
    return JSON.stringify(payload);
  }

  const domains = getAttributionDomains(sourceRecord);
  const nextRecord: Record<string, unknown> = { ...actorRecord };

  delete nextRecord[TOOT_ATTRIBUTION_DOMAINS_IRI];
  delete nextRecord[TOOT_ATTRIBUTION_DOMAINS_SHORT];

  if (domains.length > 0) {
    nextRecord["attributionDomains"] = domains;
  } else {
    delete nextRecord["attributionDomains"];
  }

  const enriched =
    domains.length > 0 && !contextIncludesAuthorAttributionTerms(nextRecord["@context"])
      ? withContextEntry(nextRecord, TOOT_AUTHOR_ATTRIBUTION_CONTEXT)
      : nextRecord;

  return JSON.stringify(enriched);
}
