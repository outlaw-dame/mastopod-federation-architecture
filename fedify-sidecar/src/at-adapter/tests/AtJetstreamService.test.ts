import { describe, expect, it } from "vitest";
import { DEFAULT_JETSTREAM_URL, parseJetstreamUrl } from "../jetstream/AtJetstreamService.js";

describe("AtJetstreamService URL policy", () => {
  it("defaults to a bounded Bluesky-hosted collection filter", () => {
    const url = new URL(parseJetstreamUrl(undefined));

    expect(parseJetstreamUrl(undefined)).toBe(DEFAULT_JETSTREAM_URL);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/subscribe");
    expect(url.searchParams.getAll("wantedCollections")).toEqual([
      "app.bsky.feed.post",
      "app.bsky.actor.profile",
    ]);
  });

  it("rejects unbounded or unsafe Jetstream URLs", () => {
    expect(() => parseJetstreamUrl("https://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post")).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => parseJetstreamUrl("wss://user:pass@jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post")).toThrow(/credentials/);
    expect(() => parseJetstreamUrl("wss://jetstream2.us-east.bsky.network/")).toThrow(/path/);
    expect(() => parseJetstreamUrl("wss://jetstream2.us-east.bsky.network/subscribe")).toThrow(/wantedCollections or wantedDids/);
    expect(() => parseJetstreamUrl("wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=not valid")).toThrow(/invalid/);
  });
});
