import { Buffer } from "node:buffer";
import type { CanonicalFacet } from "../canonical/CanonicalContent.js";

type AtFacetFeature = Record<string, string>;

export interface AtFacet {
  index: {
    byteStart: number;
    byteEnd: number;
  };
  features: AtFacetFeature[];
}

export function canonicalFacetsToAtFacets(
  text: string,
  facets: readonly CanonicalFacet[],
): AtFacet[] {
  return facets
    .map((facet) => toAtFacet(text, facet))
    .filter((facet): facet is AtFacet => facet !== null);
}

function toAtFacet(text: string, facet: CanonicalFacet): AtFacet | null {
  if (!Number.isInteger(facet.start) || !Number.isInteger(facet.end) || facet.start < 0 || facet.end <= facet.start) {
    return null;
  }

  if (facet.end > text.length) {
    return null;
  }

  const byteStart = Buffer.byteLength(text.slice(0, facet.start), "utf8");
  const byteEnd = Buffer.byteLength(text.slice(0, facet.end), "utf8");

  const feature = facetToFeature(facet);
  if (!feature) {
    return null;
  }

  return {
    index: {
      byteStart,
      byteEnd,
    },
    features: [feature],
  };
}

function facetToFeature(facet: CanonicalFacet): AtFacetFeature | null {
  switch (facet.type) {
    case "mention":
      if (!facet.target.did) {
        return null;
      }
      return {
        $type: "app.bsky.richtext.facet#mention",
        did: facet.target.did,
      };
    case "tag":
      return {
        $type: "app.bsky.richtext.facet#tag",
        tag: facet.tag,
      };
    case "link":
      return {
        $type: "app.bsky.richtext.facet#link",
        uri: facet.url,
      };
  }
}
