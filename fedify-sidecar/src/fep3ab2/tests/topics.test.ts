import { describe, expect, it } from "vitest";
import {
  collectUriDerivedTopicsFromPayload,
  isBoundedWildcardSubscription,
  isValidSubscriptionTopic,
  topicMatches,
  uriToTopic,
} from "../topics.js";

describe("fep3ab2 topic utilities", () => {
  it("converts ActivityPub URIs to FEP topics", () => {
    expect(uriToTopic("https://server.example/note/1")).toBe("server.example/note/1");
    expect(uriToTopic("https://server.example:1000/actor+123#xyz")).toBe(
      "server.example:1000/actor%2B123/xyz",
    );
  });

  it("validates bounded wildcard subscriptions", () => {
    expect(isBoundedWildcardSubscription("server.example/note/#")).toBe(true);
    expect(isBoundedWildcardSubscription("server.example/#")).toBe(true);
    expect(isValidSubscriptionTopic("server.example/note/#")).toBe(true);
    expect(isValidSubscriptionTopic("#")).toBe(false);
    expect(isValidSubscriptionTopic("server.example/note/#/extra")).toBe(false);
  });

  it("matches wildcard subscriptions against published topics", () => {
    expect(topicMatches("server.example/note/#", "server.example/note/123")).toBe(true);
    expect(topicMatches("server.example/actor/+", "server.example/actor/alice")).toBe(true);
    expect(topicMatches("server.example/actor/+", "server.example/note/123")).toBe(false);
  });

  it("collects URI-derived topics from payload objects", () => {
    const topics = collectUriDerivedTopicsFromPayload({
      id: "https://server.example/activities/1",
      actor: "https://server.example/users/alice",
      object: {
        id: "https://remote.example/note/123",
      },
    });

    expect(topics).toEqual([
      "remote.example/note/123",
      "server.example/activities/1",
      "server.example/users/alice",
    ]);
  });
});
