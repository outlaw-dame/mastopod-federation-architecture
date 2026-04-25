import {
  FEP_268D_CONTEXT,
  SEARCHABLE_BY_IRI,
  TOOT_INDEXABLE_IRI,
  TOOT_INDEXABLE_SHORT,
  getIndexableValue,
  getSearchableBy,
  normalizeSearchableByForOutput,
} from "../../utils/searchConsent.js";

const TOOT_CONTEXT = {
  toot: "http://joinmastodon.org/ns#",
  indexable: "toot:indexable",
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contextIncludesFep268d(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => contextIncludesFep268d(entry));
  }

  if (value === FEP_268D_CONTEXT) {
    return true;
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return record["searchableBy"] === SEARCHABLE_BY_IRI;
}

function contextIncludesTootIndexable(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => contextIncludesTootIndexable(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return (
    record["toot"] === TOOT_CONTEXT.toot ||
    record["indexable"] === TOOT_CONTEXT.indexable ||
    record["indexable"] === TOOT_INDEXABLE_IRI
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

export function withActorSearchConsentProperties(
  payload: unknown,
  sourceActor: unknown,
): string {
  const actorRecord = asRecord(payload);
  const sourceRecord = asRecord(sourceActor);
  if (!actorRecord || !sourceRecord) {
    return JSON.stringify(payload);
  }

  const searchableBy = getSearchableBy(sourceRecord);
  const indexable = getIndexableValue(sourceRecord);
  const nextRecord: Record<string, unknown> = { ...actorRecord };

  delete nextRecord[SEARCHABLE_BY_IRI];
  delete nextRecord[TOOT_INDEXABLE_IRI];
  delete nextRecord[TOOT_INDEXABLE_SHORT];

  if (searchableBy.length > 0) {
    nextRecord["searchableBy"] = normalizeSearchableByForOutput(searchableBy);
  } else {
    delete nextRecord["searchableBy"];
  }

  if (indexable !== null) {
    nextRecord["indexable"] = indexable;
  } else if (searchableBy.length === 0) {
    // FEP-5feb defaults missing actor-level consent to non-indexable.
    nextRecord["indexable"] = false;
  } else {
    delete nextRecord["indexable"];
  }

  let enriched = nextRecord;
  if (searchableBy.length > 0 && !contextIncludesFep268d(enriched["@context"])) {
    enriched = withContextEntry(enriched, FEP_268D_CONTEXT);
  }
  if (typeof enriched["indexable"] === "boolean" && !contextIncludesTootIndexable(enriched["@context"])) {
    enriched = withContextEntry(enriched, TOOT_CONTEXT);
  }

  return JSON.stringify(enriched);
}
