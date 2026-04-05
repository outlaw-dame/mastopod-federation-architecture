import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalFacet } from "../canonical/CanonicalContent.js";

type ResolveMentionTarget = (did: string) => Promise<CanonicalActorRef | null>;

interface AtFacetFeature {
  $type?: string;
  did?: string;
  uri?: string;
  tag?: string;
}

interface AtFacet {
  index?: {
    byteStart?: number;
    byteEnd?: number;
  };
  features?: AtFacetFeature[];
}

export async function atFacetsToCanonicalFacets(
  text: string,
  rawFacets: readonly unknown[],
  resolveMentionTarget?: ResolveMentionTarget,
): Promise<CanonicalFacet[]> {
  const facets: CanonicalFacet[] = [];

  for (const rawFacet of rawFacets) {
    const facet = rawFacet as AtFacet;
    const byteStart = facet.index?.byteStart;
    const byteEnd = facet.index?.byteEnd;

    if (
      typeof byteStart !== "number" ||
      typeof byteEnd !== "number" ||
      !Number.isInteger(byteStart) ||
      !Number.isInteger(byteEnd) ||
      byteStart < 0 ||
      byteEnd <= byteStart
    ) {
      continue;
    }

    const [start, end] = byteRangeToCodeUnitRange(text, byteStart, byteEnd);
    if (end <= start || end > text.length) {
      continue;
    }

    const label = text.slice(start, end);
    for (const feature of facet.features ?? []) {
      const canonicalFacet = await featureToCanonicalFacet(feature, label, start, end, resolveMentionTarget);
      if (canonicalFacet) {
        facets.push(canonicalFacet);
      }
    }
  }

  return facets;
}

async function featureToCanonicalFacet(
  feature: AtFacetFeature,
  label: string,
  start: number,
  end: number,
  resolveMentionTarget?: ResolveMentionTarget,
): Promise<CanonicalFacet | null> {
  switch (feature.$type) {
    case "app.bsky.richtext.facet#mention": {
      if (!feature.did) {
        return null;
      }
      const target = (await resolveMentionTarget?.(feature.did)) ?? { did: feature.did };
      return {
        type: "mention",
        label,
        target,
        start,
        end,
      };
    }
    case "app.bsky.richtext.facet#tag":
      if (!feature.tag) {
        return null;
      }
      return {
        type: "tag",
        tag: feature.tag,
        start,
        end,
      };
    case "app.bsky.richtext.facet#link":
      if (!feature.uri) {
        return null;
      }
      return {
        type: "link",
        url: feature.uri,
        start,
        end,
      };
    default:
      return null;
  }
}

function byteRangeToCodeUnitRange(text: string, byteStart: number, byteEnd: number): [number, number] {
  let bytesSeen = 0;
  let start = -1;
  let end = -1;
  let codeUnitIndex = 0;

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    const nextByteIndex = bytesSeen + characterBytes;

    if (start === -1 && byteStart <= bytesSeen) {
      start = codeUnitIndex;
    }
    if (start === -1 && byteStart < nextByteIndex) {
      start = codeUnitIndex;
    }
    if (end === -1 && byteEnd <= bytesSeen) {
      end = codeUnitIndex;
      break;
    }
    if (end === -1 && byteEnd <= nextByteIndex) {
      end = codeUnitIndex + character.length;
      break;
    }

    bytesSeen = nextByteIndex;
    codeUnitIndex += character.length;
  }

  if (start === -1) {
    start = text.length;
  }
  if (end === -1) {
    end = text.length;
  }

  return [start, end];
}
