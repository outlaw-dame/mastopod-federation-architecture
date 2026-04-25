export const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
export const FEP_268D_CONTEXT = "https://w3id.org/fep/268d";
export const SEARCHABLE_BY_IRI = "http://fedibird.com/ns#searchableBy";
export const TOOT_INDEXABLE_IRI = "http://joinmastodon.org/ns#indexable";
export const TOOT_INDEXABLE_SHORT = "toot:indexable";

const AS_PUBLIC_ALIASES = new Set([AS_PUBLIC, "as:Public", "Public"]);
const SEARCHABLE_BY_KEYS = ["searchableBy", SEARCHABLE_BY_IRI] as const;
const INDEXABLE_KEYS = ["indexable", TOOT_INDEXABLE_IRI, TOOT_INDEXABLE_SHORT] as const;

export type PublicSearchConsentSource =
  | "object_searchableBy"
  | "actor_searchableBy"
  | "actor_indexable"
  | "none";

export interface PublicSearchConsentSignal {
  raw: string[];
  isPublic: boolean;
  explicitlySet: boolean;
  source: PublicSearchConsentSource;
  objectSearchableBy: string[];
  actorSearchableBy: string[];
  actorIndexable: boolean | null;
  actorIndexableExplicit: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value != null ? [value] : [];
}

function normalizeIri(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return AS_PUBLIC_ALIASES.has(trimmed) ? AS_PUBLIC : trimmed;
}

function extractUriFromNode(value: unknown): string | null {
  const direct = normalizeIri(value);
  if (direct) {
    return direct;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return normalizeIri(record["id"] ?? record["@id"] ?? record["href"]);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function resolveSearchableBy(rawValue: unknown): string[] {
  if (rawValue == null || (Array.isArray(rawValue) && rawValue.length === 0)) {
    return [];
  }

  return unique(
    toArray(rawValue)
      .map((entry) => extractUriFromNode(entry))
      .filter((entry): entry is string => typeof entry === "string"),
  );
}

export function getSearchableBy(object: unknown): string[] {
  const record = asRecord(object);
  if (!record) {
    return [];
  }

  for (const key of SEARCHABLE_BY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return resolveSearchableBy(record[key]);
    }
  }

  return [];
}

export function getIndexableValue(actor: unknown): boolean | null {
  const record = asRecord(actor);
  if (!record) {
    return null;
  }

  for (const key of INDEXABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }

    const raw = record[key];
    if (typeof raw === "boolean") {
      return raw;
    }
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
  }

  return null;
}

export function normalizeSearchableByForOutput(
  value: string[] | string | null | undefined,
): string | string[] | undefined {
  const normalized = resolveSearchableBy(value);
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length === 1 ? normalized[0] : normalized;
}

export function isPublicAddressed(object: unknown): boolean {
  const record = asRecord(object);
  if (!record) {
    return false;
  }

  return ["to", "cc"].some((field) =>
    toArray(record[field])
      .map((entry) => extractUriFromNode(entry))
      .some((entry) => entry === AS_PUBLIC),
  );
}

function includesPublic(searchableBy: string[]): boolean {
  return searchableBy.includes(AS_PUBLIC);
}

export function resolvePublicSearchConsent(
  object: unknown,
  options: { attributedToActor?: unknown } = {},
): PublicSearchConsentSignal {
  const objectSearchableBy = getSearchableBy(object);
  if (objectSearchableBy.length > 0) {
    return {
      raw: objectSearchableBy,
      isPublic: includesPublic(objectSearchableBy),
      explicitlySet: true,
      source: "object_searchableBy",
      objectSearchableBy,
      actorSearchableBy: [],
      actorIndexable: null,
      actorIndexableExplicit: false,
    };
  }

  const actorSearchableBy = getSearchableBy(options.attributedToActor);
  if (actorSearchableBy.length > 0) {
    return {
      raw: actorSearchableBy,
      isPublic: includesPublic(actorSearchableBy),
      explicitlySet: true,
      source: "actor_searchableBy",
      objectSearchableBy: [],
      actorSearchableBy,
      actorIndexable: null,
      actorIndexableExplicit: false,
    };
  }

  const actorIndexable = getIndexableValue(options.attributedToActor);
  if (actorIndexable !== null) {
    return {
      raw: [],
      isPublic: actorIndexable === true,
      explicitlySet: true,
      source: "actor_indexable",
      objectSearchableBy: [],
      actorSearchableBy: [],
      actorIndexable,
      actorIndexableExplicit: true,
    };
  }

  return {
    raw: [],
    isPublic: false,
    explicitlySet: false,
    source: "none",
    objectSearchableBy: [],
    actorSearchableBy: [],
    actorIndexable: null,
    actorIndexableExplicit: false,
  };
}

export function normalizePublicSearchConsent(value: unknown): PublicSearchConsentSignal | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const objectSearchableBy = resolveSearchableBy(record["objectSearchableBy"]);
  const actorSearchableBy = resolveSearchableBy(record["actorSearchableBy"]);
  const raw = resolveSearchableBy(record["raw"]);
  const actorIndexable = getIndexableValue({ indexable: record["actorIndexable"] });
  const actorIndexableExplicit =
    typeof record["actorIndexableExplicit"] === "boolean"
      ? record["actorIndexableExplicit"]
      : actorIndexable !== null;

  const sourceValue = record["source"];
  const source: PublicSearchConsentSource =
    sourceValue === "object_searchableBy" ||
    sourceValue === "actor_searchableBy" ||
    sourceValue === "actor_indexable" ||
    sourceValue === "none"
      ? sourceValue
      : objectSearchableBy.length > 0
        ? "object_searchableBy"
        : actorSearchableBy.length > 0
          ? "actor_searchableBy"
          : actorIndexableExplicit
            ? "actor_indexable"
            : "none";

  const derivedRaw =
    source === "object_searchableBy"
      ? objectSearchableBy
      : source === "actor_searchableBy"
        ? actorSearchableBy
        : raw;
  const derivedIsPublic =
    source === "object_searchableBy"
      ? includesPublic(objectSearchableBy)
      : source === "actor_searchableBy"
        ? includesPublic(actorSearchableBy)
        : source === "actor_indexable"
          ? actorIndexable === true
          : false;

  return {
    raw: derivedRaw,
    isPublic: typeof record["isPublic"] === "boolean" ? record["isPublic"] : derivedIsPublic,
    explicitlySet:
      typeof record["explicitlySet"] === "boolean" ? record["explicitlySet"] : source !== "none",
    source,
    objectSearchableBy,
    actorSearchableBy,
    actorIndexable,
    actorIndexableExplicit,
  };
}

export function isPublicSearchIndexable(
  object: unknown,
  options: { attributedToActor?: unknown; consent?: PublicSearchConsentSignal } = {},
): boolean {
  const consent =
    options.consent ?? resolvePublicSearchConsent(object, { attributedToActor: options.attributedToActor });

  return isPublicAddressed(object) && consent.isPublic;
}
