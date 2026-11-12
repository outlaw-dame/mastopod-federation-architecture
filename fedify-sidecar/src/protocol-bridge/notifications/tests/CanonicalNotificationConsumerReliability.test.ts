import { describe, expect, it, vi } from "vitest";
import { CanonicalNotificationConsumer } from "../CanonicalNotificationConsumer.js";
import type { CanonicalNotificationConsumerConfig } from "../CanonicalNotificationConsumer.js";

function consumer() {
  const config: CanonicalNotificationConsumerConfig = {
    brokers: ["127.0.0.1:9092"],
    clientId: "test-notify",
    consumerGroupId: "test-notify-group",
    canonicalTopic: "canonical.v1",
    activityPodsBaseUrl: "http://127.0.0.1:3000",
    activityPodsBearerToken: "not-a-real-token",
    concurrency: 2,
    notifyTimeoutMs: 1000,
  };
  return new CanonicalNotificationConsumer(config);
}
function payload() {
  const item = JSON.stringify({
    kind: "FollowAdd", canonicalIntentId: "intent-a",
    sourceProtocol: "activitypub", actor: { webId: "https://remote.example/alice" },
    createdAt: "2026-11-11T00:00:00.000Z",
  });
  return {
    batch: { messages: [{ offset: "1", value: Buffer.from(item) }] },
    resolveOffset: vi.fn(),
    commitOffsetsIfNecessary: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    isRunning: () => true, isStale: () => false,
  };
}

describe("canonical notification Kafka acceptance", () => {
  it("does not advance Kafka offsets when downstream delivery fails", async () => {
    const subject = consumer() as unknown as {
      fanOut: (event: unknown) => Promise<void>;
      processBatch: (batch: unknown) => Promise<void>;
    };
    subject.fanOut = vi.fn(async () => { throw new Error("pod unavailable"); });
    const batch = payload();
    await expect(subject.processBatch(batch)).rejects.toThrow("pod unavailable");
    expect(batch.resolveOffset).not.toHaveBeenCalled();
    expect(batch.commitOffsetsIfNecessary).not.toHaveBeenCalled();
  });

  it("advances offsets only after downstream resolves", async () => {
    const subject = consumer() as unknown as {
      fanOut: (event: unknown) => Promise<void>;
      processBatch: (batch: unknown) => Promise<void>;
    };
    subject.fanOut = vi.fn(async () => undefined);
    const batch = payload();
    await subject.processBatch(batch);
    expect(batch.resolveOffset).toHaveBeenCalledWith("1");
    expect(batch.commitOffsetsIfNecessary).toHaveBeenCalledTimes(1);
  });

  it("rejects unbounded concurrency and timeout configuration", () => {
    const config = {
      brokers: ["127.0.0.1:9092"], clientId: "test", consumerGroupId: "test",
      canonicalTopic: "canonical.v1", activityPodsBaseUrl: "http://127.0.0.1:3000",
      activityPodsBearerToken: "x",
    };
    expect(() => new CanonicalNotificationConsumer({ ...config, concurrency: 200 }))
      .toThrow(/timeout\/concurrency budget/);
    expect(() => new CanonicalNotificationConsumer({ ...config, notifyTimeoutMs: -1 }))
      .toThrow(/timeout\/concurrency budget/);
  });
});
