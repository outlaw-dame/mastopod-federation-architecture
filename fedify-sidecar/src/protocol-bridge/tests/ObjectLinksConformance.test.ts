import { describe, expect, it } from "vitest";
import { buildTagFacets } from "../activitypub/translators/shared.js";
import { canonicalFacetsToApTags } from "../projectors/activitypub/PostCreateToApProjector.js";

describe("FEP-e232 object links", () => {
  it("converts AP Link tags to canonical link facets", async () => {
    const text = "This is a quote: RE: https://server.example/objects/123";
    const facets = await buildTagFacets(
      text,
      [{
        type: "Link",
        mediaType: "application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"",
        href: "https://server.example/objects/123",
        name: "RE: https://server.example/objects/123",
      }],
      {
        resolveActorRef: async () => ({
          canonicalActorId: "actor:local",
          activityPubActorUri: "https://example.com/users/local",
        }),
      } as any,
    );

    expect(facets).toEqual([
      {
        type: "link",
        url: "https://server.example/objects/123",
        start: text.indexOf("RE: https://server.example/objects/123"),
        end: text.indexOf("RE: https://server.example/objects/123") + "RE: https://server.example/objects/123".length,
      },
    ]);
  });

  it("accepts application/activity+json as equivalent media type for AP Link tags", async () => {
    const text = "https://server.example/objects/123";
    const facets = await buildTagFacets(
      text,
      [{
        type: "Link",
        mediaType: "application/activity+json",
        href: "https://server.example/objects/123",
      }],
      {
        resolveActorRef: async () => ({
          canonicalActorId: "actor:local",
          activityPubActorUri: "https://example.com/users/local",
        }),
      } as any,
    );

    expect(facets).toEqual([
      {
        type: "link",
        url: "https://server.example/objects/123",
        start: 0,
        end: "https://server.example/objects/123".length,
      },
    ]);
  });

  it("rejects AP Link tags with unsafe href or missing mediaType", async () => {
    const text = "bad links";
    const facets = await buildTagFacets(
      text,
      [
        {
          type: "Link",
          href: "https://server.example/objects/123",
        },
        {
          type: "Link",
          mediaType: "application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"",
          href: "javascript:alert(1)",
        },
      ],
      {
        resolveActorRef: async () => ({
          canonicalActorId: "actor:local",
          activityPubActorUri: "https://example.com/users/local",
        }),
      } as any,
    );

    expect(facets).toEqual([]);
  });

  it("projects canonical link facets to AP Link tags", () => {
    const tags = canonicalFacetsToApTags([
      {
        type: "link",
        url: "https://server.example/objects/123",
        start: 0,
        end: 34,
      },
    ]);

    expect(tags).toEqual([
      {
        type: "Link",
        mediaType: "application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"",
        href: "https://server.example/objects/123",
      },
    ]);
  });

  it("does not project unsafe canonical link facets", () => {
    const tags = canonicalFacetsToApTags([
      {
        type: "link",
        url: "javascript:alert(1)",
        start: 0,
        end: 19,
      },
    ]);

    expect(tags).toEqual([]);
  });
});
