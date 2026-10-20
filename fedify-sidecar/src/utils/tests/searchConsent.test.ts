import { describe, expect, it } from "vitest";
import {
  AS_PUBLIC,
  getSearchableBy,
  isExplicitPublicSearchOptOut,
  isPublicSearchIndexable,
  normalizePublicSearchConsent,
  resolvePublicSearchConsent,
} from "../searchConsent.js";

describe("searchConsent", () => {
  it("distinguishes absent metadata from an explicit search opt-out", () => {
    const absent = resolvePublicSearchConsent({ type: "Note", to: [AS_PUBLIC] });

    expect(absent).toMatchObject({ explicitlySet: false, isPublic: false, source: "none" });
    expect(isExplicitPublicSearchOptOut(absent)).toBe(false);
    expect(isExplicitPublicSearchOptOut({ ...absent, explicitlySet: true })).toBe(true);
  });

  it("treats empty searchableBy arrays as semantically undefined", () => {
    expect(getSearchableBy({ searchableBy: [] })).toEqual([]);
  });

  it("gives object searchableBy precedence over actor-level indexable", () => {
    const consent = resolvePublicSearchConsent(
      {
        type: "Note",
        to: [AS_PUBLIC],
        searchableBy: "https://example.com/users/alice",
      },
      {
        attributedToActor: {
          id: "https://example.com/users/bob",
          indexable: true,
        },
      },
    );

    expect(consent.source).toBe("object_searchableBy");
    expect(consent.isPublic).toBe(false);
    expect(isPublicSearchIndexable({ to: [AS_PUBLIC] }, { consent })).toBe(false);
  });

  it("inherits actor searchableBy when the object omits the property", () => {
    const consent = resolvePublicSearchConsent(
      { type: "Note", to: [AS_PUBLIC] },
      {
        attributedToActor: {
          id: "https://example.com/users/bob",
          searchableBy: AS_PUBLIC,
        },
      },
    );

    expect(consent.source).toBe("actor_searchableBy");
    expect(consent.isPublic).toBe(true);
    expect(isPublicSearchIndexable({ to: [AS_PUBLIC] }, { consent })).toBe(true);
  });

  it("falls back to actor indexable when searchableBy is absent", () => {
    const consent = resolvePublicSearchConsent(
      { type: "Note", to: [AS_PUBLIC] },
      {
        attributedToActor: {
          id: "https://example.com/users/bob",
          indexable: true,
        },
      },
    );

    expect(consent.source).toBe("actor_indexable");
    expect(consent.isPublic).toBe(true);
  });

  it("fails closed for public indexing when no consent signal is present", () => {
    const consent = resolvePublicSearchConsent({ type: "Note", to: [AS_PUBLIC] });

    expect(consent.source).toBe("none");
    expect(consent.isPublic).toBe(false);
    expect(isPublicSearchIndexable({ to: [AS_PUBLIC] }, { consent })).toBe(false);
  });

  it("normalizes legacy metadata payloads from the firehose", () => {
    const consent = normalizePublicSearchConsent({
      raw: [],
      isPublic: true,
      explicitlySet: true,
      actorIndexable: true,
      actorIndexableExplicit: true,
      source: "actor_indexable",
    });

    expect(consent).toMatchObject({
      isPublic: true,
      explicitlySet: true,
      source: "actor_indexable",
      actorIndexable: true,
    });
  });
});
