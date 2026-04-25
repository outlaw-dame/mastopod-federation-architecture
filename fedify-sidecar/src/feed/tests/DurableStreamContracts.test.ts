import { describe, expect, it } from "vitest";
import { StreamSubscriptionRequestSchema } from "../DurableStreamContracts.js";

describe("StreamSubscriptionRequestSchema", () => {
  it("accepts websocket subscriptions across canonical and stream2", () => {
    const parsed = StreamSubscriptionRequestSchema.parse({
      transport: "websocket",
      streams: ["stream2", "canonical"],
      viewerId: "did:plc:alice",
      filters: { tags: ["fediverse"] },
    });

    expect(parsed.transport).toBe("websocket");
    expect(parsed.streams).toEqual(["stream2", "canonical"]);
  });

  it("rejects duplicate streams", () => {
    expect(() =>
      StreamSubscriptionRequestSchema.parse({
        transport: "sse",
        streams: ["stream1", "stream1"],
      }),
    ).toThrow(/must not contain duplicates/i);
  });
});
