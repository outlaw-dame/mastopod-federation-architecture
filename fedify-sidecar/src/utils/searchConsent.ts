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

/**
 * Detects whether an AP object carries an Akkoma-style local-scope address.
 *
 * Akkoma local posts include `<instanceBaseUrl>/#Public` (e.g.
 * `https://example.org/#Public`) in `to`.  This is intentionally different
 * from `as:Public` so that external servers cannot accidentally treat it as
 * globally public.
 *
 * Returns true when ANY entry in `to` matches the `<scheme>://<host>/#Public`
 * pattern, regardless of whether `as:Public` is also present.
 *
 * Spec refs:
 *   - https://docs.akkoma.dev/stable/development/ap_extensions/#local-post-scope
 *   - "An implementation creating a new post MUST NOT address both the local
 *     and general public scope at the same time."
 *   - "A post addressing the local scope MUST NOT be sent to other instances."
 */
export function isAkkomaLocalScopeAddressed(object: unknown): boolean {
  const record = asRecord(object);
  if (!record) return false;

  const toEntries = toArray(record["to"]).map((entry) => extractUriFromNode(entry));
  return toEntries.some(isLocalScopeUri);
}

/**
 * Returns true when the object's addressing indicates a local-only scope AND
 * does NOT include `as:Public` — meaning the activity was intended only for
 * the origin instance.
 *
 * When receiving a remote post that addresses both `<domain>/#Public` AND
 * `as:Public`, the Akkoma spec says to treat it as a normal public post
 * (no special local meaning).  This function returns false in that case.
 */
export function isLocalScopeOnly(object: unknown): boolean {
  if (!isAkkomaLocalScopeAddressed(object)) return false;
  // If as:Public is also present in to or cc, treat as normal public per spec.
  return !isPublicAddressed(object);
}

/** Returns true when the URI matches the Akkoma local-scope pattern `<scheme>://<host>/#Public`. */
export function isLocalScopeUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  try {
    const parsed = new URL(uri);
    return parsed.hash === "#Public" && parsed.pathname === "/";
  } catch {
    return false;
  }
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

/**
 * Returns true if the object's `to` or `cc` addressing includes a followers collection
 * but NOT `as:Public`.
 *
 * This indicates followers-only scope where only post authors should be able
 * to Announce the post (to prevent unintended scope escalation).
 *
 * Used by Step 3.85 Announce authorization guard to enforce platform conventions.
 */
export function isFollowersOnlyAddressing(object: unknown): boolean {
  const record = asRecord(object);
  if (!record) return false;

  // Check if as:Public is present in to or cc
  const isPublic = isPublicAddressed(record);
  if (isPublic) return false;

  // Check if any to/cc entry looks like a followers collection
  const toEntries = toArray(record["to"]).map((entry) => extractUriFromNode(entry));
  const ccEntries = toArray(record["cc"]).map((entry) => extractUriFromNode(entry));
  const allRecipients = [...toEntries, ...ccEntries].filter((u): u is string => u !== null);

  return allRecipients.some((uri) => {
    if (!uri) return false;
    // Match common followers collection patterns:
    // - /followers or /followers/
    // - ?type=followers or similar query patterns
    return uri.includes("/followers") || uri.includes("followers");
  });
}

/**
 * Extracts the canonical audience scope from an activity:
 * - "public": as:Public is addressed
 * - "followers": followers collection is addressed but not as:Public
 * - "direct": only specific actors, no public or followers
 * - "local": Akkoma local-scope-only addressing
 *
 * Helps ensure outbound conformance checks and visibility routing work correctly.
 */
export function getAudienceScope(object: unknown): "public" | "followers" | "direct" | "local" {
  const record = asRecord(object);
  if (!record) return "direct";

  // Check local-scope first (takes precedence)
  if (isLocalScopeOnly(record)) return "local";

  // Check public
  if (isPublicAddressed(record)) return "public";

  // Check followers-only
  if (isFollowersOnlyAddressing(record)) return "followers";

  // Default to direct messaging scope
  return "direct";
}

/**
 * Extracts audience recipient URIs from `to` and `cc` fields, filtering out
 * special addressing URIs (as:Public, followers collections, etc).
 *
 * Returns Set of unique actor URIs intended as direct recipients.
 * Useful for conformance checks to ensure delivery targets match declared scope.
 */
export function getDirectRecipients(object: unknown): Set<string> {
  const record = asRecord(object);
  if (!record) return new Set();

  const toEntries = toArray(record["to"]);
  const ccEntries = toArray(record["cc"]);
  const allRecipients = [...toEntries, ...ccEntries];

  const directRecipients = new Set<string>();

  for (const entry of allRecipients) {
    const uri = extractUriFromNode(entry);
    if (!uri) continue;

    // Skip special addressing URIs
    if (AS_PUBLIC_ALIASES.has(uri)) continue;
    if (isLocalScopeUri(uri)) continue;
    if (uri.includes("/followers")) continue;

    // Add as direct recipient
    directRecipients.add(uri);
  }

  return directRecipients;
}
