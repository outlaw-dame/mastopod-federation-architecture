import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildInlineLinkAndTagFacets,
  buildTagFacets,
} from "../activitypub/translators/shared.js";

type ExtractTextCase = {
  input: string;
  expected: string[];
};

type ExtractApTagsCase = {
  input: Array<{ type: string; name: string }>;
  expected: string[];
};

type ConformanceFixture = {
  extractFromText: ExtractTextCase[];
  extractFromActivityPubTags: ExtractApTagsCase[];
};

const thisDir = dirname(fileURLToPath(import.meta.url));
const conformancePath = resolve(thisDir, "../../../../shared/hashtag-conformance-matrix.json");
const conformanceFixture = JSON.parse(
  readFileSync(conformancePath, "utf8"),
) as ConformanceFixture;

function uniqueInOrder(values: string[]): string[] {
  return Array.from(new Set(values));
}

describe("Canonical hashtag conformance", () => {
  it("extracts canonical inline tag facets per shared text fixtures", () => {
    for (const testCase of conformanceFixture.extractFromText) {
      const tags = buildInlineLinkAndTagFacets(testCase.input)
        .filter((facet) => facet.type === "tag")
        .map((facet) => facet.tag);

      expect(uniqueInOrder(tags)).toEqual(testCase.expected);
    }
  });

  it("normalizes AP hashtag tag objects into canonical tag facets", async () => {
    for (const testCase of conformanceFixture.extractFromActivityPubTags) {
      const text = testCase.input
        .filter((tag) => tag.type === "Hashtag")
        .map((tag) => tag.name)
        .join(" ");

      const facets = await buildTagFacets(text, testCase.input, {
        resolveActorRef: async () => ({
          canonicalActorId: "actor:local",
          activityPubActorUri: "https://example.com/users/local",
        }),
      } as any);

      const tags = facets.filter((facet) => facet.type === "tag").map((facet) => facet.tag);
      expect(uniqueInOrder(tags)).toEqual(testCase.expected);
    }
  });
});
