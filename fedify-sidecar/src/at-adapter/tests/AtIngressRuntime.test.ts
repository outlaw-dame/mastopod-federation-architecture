import { describe, expect, it, vi } from "vitest";
import { AtIngressRuntime } from "../ingress/AtIngressRuntime.js";

describe("AtIngressRuntime", () => {
  it("starts raw-topic consumption and boots configured firehose sources", async () => {
    const consumer = createMockConsumer();
    const firehoseConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const verifier = {
      handleRawEvent: vi.fn().mockResolvedValue(true),
    };

    const runtime = new AtIngressRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "at-ingress-runtime-test",
        consumerGroupId: "at-ingress-runtime-test",
        rawTopic: "at.firehose.raw.v1",
        sources: [
          {
            id: "relay-main",
            url: "wss://relay.example",
            sourceType: "relay",
          },
        ],
      },
      firehoseConsumer,
      verifier,
      consumerFactory: () => consumer,
    });

    await runtime.start();

    expect(consumer.subscribe).toHaveBeenCalledWith({ topic: "at.firehose.raw.v1" });
    expect(firehoseConsumer.start).toHaveBeenCalledWith({
      id: "relay-main",
      url: "wss://relay.example",
      sourceType: "relay",
    });
  });

  it("returns verifier decisions for raw envelopes and drops malformed payloads safely", async () => {
    const verifier = {
      handleRawEvent: vi.fn().mockResolvedValue(false),
    };

    const runtime = new AtIngressRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "at-ingress-runtime-test",
        consumerGroupId: "at-ingress-runtime-test",
        rawTopic: "at.firehose.raw.v1",
        sources: [],
      },
      firehoseConsumer: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      verifier,
      consumerFactory: () => createMockConsumer(),
    });

    await expect(
      runtime.handleRawEnvelope({
        seq: 1,
        source: "wss://relay.example",
        eventType: "#commit",
        receivedAt: "2026-04-03T12:00:00.000Z",
        rawCborBase64: "AQID",
      }),
    ).resolves.toBe(false);

    await expect(runtime.handleRawEnvelope({ malformed: true })).resolves.toBe(true);
    expect(verifier.handleRawEvent).toHaveBeenCalledTimes(1);
  });
});

function createMockConsumer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}
