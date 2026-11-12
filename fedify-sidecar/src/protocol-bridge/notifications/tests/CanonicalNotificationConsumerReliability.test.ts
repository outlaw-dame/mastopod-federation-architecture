import { describe, expect, it, vi } from "vitest";
import { CanonicalNotificationConsumer, CANONICAL_NOTIFICATION_DEAD_LETTER_TOPIC } from "../CanonicalNotificationConsumer.js";
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

describe("canonical notification durable quarantine and ordered Kafka offsets", () => {
  function makeConsumer(publish: (key: string, value: Buffer) => Promise<void>) {
    return new CanonicalNotificationConsumer({
      brokers: ["127.0.0.1:9092"], clientId: "dlq-test",
      consumerGroupId: "dlq-test-group", canonicalTopic: "canonical.v1",
      activityPodsBaseUrl: "http://127.0.0.1:3000",
      activityPodsBearerToken: "test-only",
      enableDeadLetter: true,
      deadLetterTopic: CANONICAL_NOTIFICATION_DEAD_LETTER_TOPIC,
      concurrency: 2,
    }, undefined, { publish }) as unknown as {
      processBatch: (batch: unknown) => Promise<void>;
      fanOut: (event: unknown) => Promise<void>;
    };
  }

  it("writes malformed JSON to the restricted durable DLQ before offset resolution", async () => {
    const publish = vi.fn(async () => undefined);
    const subject = makeConsumer(publish);
    subject.fanOut = vi.fn(async () => undefined);
    const batch = payload();
    batch.batch.messages[0] = { offset: "1", value: Buffer.from("{bad-json") };
    await subject.processBatch(batch);
    expect(publish).toHaveBeenCalledTimes(1);
    const [key, rawRecord] = publish.mock.calls[0] as unknown as [string, Buffer];
    const record = JSON.parse(rawRecord.toString("utf8")) as {
      reason: string; rawBase64: string; payloadSha256: string; sourceOffset: string;
    };
    expect(key).toContain(":1");
    expect(record.reason).toBe("INVALID_JSON");
    expect(Buffer.from(record.rawBase64, "base64").toString("utf8")).toBe("{bad-json");
    expect(record.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.resolveOffset).toHaveBeenCalledWith("1");
    expect(batch.commitOffsetsIfNecessary).toHaveBeenCalledTimes(1);
  });

  it("never skips earlier in-flight delivery when later malformed data is quarantined", async () => {
    const publish = vi.fn(async () => undefined);
    const subject = makeConsumer(publish);
    let release: (() => void) | undefined;
    subject.fanOut = vi.fn(async () =>
      new Promise<void>(resolve => { release = resolve; }));
    const batch = payload();
    batch.batch.messages.push({ offset: "2", value: Buffer.from("{unparseable") });
    const running = subject.processBatch(batch);
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(batch.resolveOffset).not.toHaveBeenCalled();
    expect(batch.commitOffsetsIfNecessary).not.toHaveBeenCalled();
    release!();
    await running;
    expect(batch.resolveOffset).toHaveBeenNthCalledWith(1, "1");
    expect(batch.resolveOffset).toHaveBeenNthCalledWith(2, "2");
    expect(batch.commitOffsetsIfNecessary).toHaveBeenCalledTimes(1);
  });

  it("failed DLQ persistence leaves all Kafka offsets uncommitted", async () => {
    const publish = vi.fn(async () => { throw new Error("redpanda unavailable"); });
    const subject = makeConsumer(publish);
    subject.fanOut = vi.fn(async () => undefined);
    const batch = payload();
    batch.batch.messages.push({ offset: "2", value: Buffer.from("{invalid") });
    await expect(subject.processBatch(batch)).rejects.toThrow(/redpanda unavailable/);
    expect(batch.resolveOffset).not.toHaveBeenCalled();
    expect(batch.commitOffsetsIfNecessary).not.toHaveBeenCalled();
  });

  it("rejects oversized records without copying private data into the quarantine topic", async () => {
    const publish = vi.fn(async () => undefined);
    const subject = makeConsumer(publish);
    subject.fanOut = vi.fn(async () => undefined);
    const batch = payload();
    batch.batch.messages[0] = {
      offset: "1", value: Buffer.alloc(262145, 65),
    };
    await expect(subject.processBatch(batch)).rejects.toThrow(/bounded quarantine size/);
    expect(publish).not.toHaveBeenCalled();
    expect(batch.resolveOffset).not.toHaveBeenCalled();
  });

  it("disabled DLQ fails closed instead of silently discarding malformed notifications", async () => {
    const subject = consumer() as unknown as {
      processBatch: (batch: unknown) => Promise<void>;
    };
    const batch = payload();
    batch.batch.messages[0] = { offset: "1", value: Buffer.from("{invalid") };
    await expect(subject.processBatch(batch)).rejects.toThrow(/quarantine not enabled/);
    expect(batch.resolveOffset).not.toHaveBeenCalled();
  });

  it("quarantines invalid notification shapes instead of acknowledging them", async () => {
    const publish = vi.fn(async () => undefined);
    const subject = makeConsumer(publish);
    subject.fanOut = vi.fn(async () => undefined);
    const batch = payload();
    batch.batch.messages[0] = {
      offset: "1",
      value: Buffer.from(JSON.stringify({
        kind: "FollowAdd", canonicalIntentId: "incomplete",
        actor: null, sourceProtocol: "activitypub",
      })),
    };
    await subject.processBatch(batch);
    const record = JSON.parse((publish.mock.calls[0] as unknown as [string, Buffer])[1].toString("utf8")) as {
      reason: string;
    };
    expect(record.reason).toBe("INVALID_PAYLOAD");
    expect(subject.fanOut).not.toHaveBeenCalled();
    expect(batch.resolveOffset).toHaveBeenCalledWith("1");
  });
});
