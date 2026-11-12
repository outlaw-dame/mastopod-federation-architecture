import { describe, expect, it, vi } from "vitest";
import { CanonicalNotificationConsumer, CANONICAL_NOTIFICATION_DEAD_LETTER_TOPIC, validateDurableCanonicalReceipt } from "../CanonicalNotificationConsumer.js";
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
  const subject = new CanonicalNotificationConsumer(config);
  (subject as unknown as { consumer: unknown }).consumer = {
    commitOffsets: vi.fn(async () => undefined)
  };
  return subject;
}
function payload() {
  const item = JSON.stringify({
    kind: "FollowAdd", canonicalIntentId: "intent-a",
    sourceProtocol: "activitypub", actor: { webId: "https://remote.example/alice" },
    createdAt: "2026-11-11T00:00:00.000Z",
  });
  return {
    batch: { topic: "canonical.v1", partition: 0, messages: [{ offset: "1", value: Buffer.from(item) }] },
    resolveOffset: vi.fn(),
    commitOffsetsIfNecessary: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    isRunning: () => true, isStale: () => false,
  };
}

function committed(subject: unknown) {
  return (subject as {
    consumer: { commitOffsets: ReturnType<typeof vi.fn> };
  }).consumer.commitOffsets;
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
    expect(committed(subject)).not.toHaveBeenCalled();
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
    expect(committed(subject)).toHaveBeenCalledTimes(1);
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
    const subject = new CanonicalNotificationConsumer({
      brokers: ["127.0.0.1:9092"], clientId: "dlq-test",
      consumerGroupId: "dlq-test-group", canonicalTopic: "canonical.v1",
      activityPodsBaseUrl: "http://127.0.0.1:3000",
      activityPodsBearerToken: "test-only",
      enableDeadLetter: true,
      deadLetterTopic: CANONICAL_NOTIFICATION_DEAD_LETTER_TOPIC,
      concurrency: 2,
    }, undefined, { publish });
    (subject as unknown as { consumer: unknown }).consumer = {
      commitOffsets: vi.fn(async () => undefined)
    };
    return subject as unknown as {
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
    expect(committed(subject)).toHaveBeenCalledTimes(1);
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
    expect(committed(subject)).not.toHaveBeenCalled();
    release!();
    await running;
    expect(batch.resolveOffset).toHaveBeenNthCalledWith(1, "1");
    expect(batch.resolveOffset).toHaveBeenNthCalledWith(2, "2");
    expect(committed(subject)).toHaveBeenCalledTimes(1);
  });

  it("failed DLQ persistence leaves all Kafka offsets uncommitted", async () => {
    const publish = vi.fn(async () => { throw new Error("redpanda unavailable"); });
    const subject = makeConsumer(publish);
    subject.fanOut = vi.fn(async () => undefined);
    const batch = payload();
    batch.batch.messages.push({ offset: "2", value: Buffer.from("{invalid") });
    await expect(subject.processBatch(batch)).rejects.toThrow(/redpanda unavailable/);
    expect(batch.resolveOffset).not.toHaveBeenCalled();
    expect(committed(subject)).not.toHaveBeenCalled();
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

describe("durable PostgreSQL acknowledgment contract", () => {
  const accepted = {
    ok:true,durable:true,duplicate:false,delivered:false,queuedRecipients:4,
    canonicalIntentId:"intent-a",
  };
  it("accepts only a genuine 202 PG commit or 409 PG duplicate", () => {
    expect(validateDurableCanonicalReceipt(202,accepted,'intent-a')).toBe(true);
    expect(validateDurableCanonicalReceipt(409,{...accepted,duplicate:true},'intent-a')).toBe(true);
    expect(validateDurableCanonicalReceipt(200,accepted,'intent-a')).toBe(false);
    expect(validateDurableCanonicalReceipt(202,{...accepted,durable:false},'intent-a')).toBe(false);
    expect(validateDurableCanonicalReceipt(202,{...accepted,duplicate:true},'intent-a')).toBe(false);
    expect(validateDurableCanonicalReceipt(409,{...accepted,duplicate:false},'intent-a')).toBe(false);
    expect(validateDurableCanonicalReceipt(202,{...accepted,queuedRecipients:65},'intent-a')).toBe(false);
    expect(validateDurableCanonicalReceipt(202,{...accepted,delivered:true},'intent-a')).toBe(false);
    expect(validateDurableCanonicalReceipt(202,null,'intent-a')).toBe(false);
    expect(validateDurableCanonicalReceipt(202,accepted,'other')).toBe(false);
    expect(validateDurableCanonicalReceipt(409,{...accepted,duplicate:true,
      canonicalIntentId:'other'},'intent-a')).toBe(false);

  });
});

describe("explicit Kafka offsets with autoCommit disabled", () => {
  it("commits last offset plus one only after contiguous persisted outcomes",async()=>{
    const subject=consumer() as unknown as {
      processBatch: (payload: unknown)=>Promise<void>;
      fanOut: (event: unknown)=>Promise<void>;
    };
    subject.fanOut=vi.fn(async()=>undefined);
    const batch=payload();
    batch.batch.messages.push({
      offset:"2",
      value:Buffer.from(JSON.stringify({
        kind:"PostEdit",canonicalIntentId:"valid-non-notification",
        actor:{webId:"https://remote.example/alice"},
        sourceProtocol:"activitypub",createdAt:"2026-11-12T00:00:00Z",
      })),
    });
    await subject.processBatch(batch);
    expect(committed(subject)).toHaveBeenCalledWith([
      { topic:"canonical.v1",partition:0,offset:"3" }
    ]);
  });
  it("does not claim success if the broker rejects the explicit commit",async()=>{
    const subject=consumer() as unknown as {
      processBatch:(payload:unknown)=>Promise<void>;
      fanOut:(event:unknown)=>Promise<void>;
    };
    subject.fanOut=vi.fn(async()=>undefined);
    committed(subject).mockRejectedValueOnce(new Error("broker unavailable"));
    await expect(subject.processBatch(payload())).rejects.toThrow("broker unavailable");
    expect(committed(subject)).toHaveBeenCalledWith([
      { topic:"canonical.v1",partition:0,offset:"2" }
    ]);
  });
});

describe("canonical poison-event classifier",()=>{
  it("does not lose a recognized ActivityPods-origin event",async()=>{
    const subject=consumer() as unknown as {
      processBatch:(payload:unknown)=>Promise<void>;
      fanOut:(event:unknown)=>Promise<void>;
    };
    subject.fanOut=vi.fn(async()=>undefined);
    const batch=payload();
    batch.batch.messages[0]={
      offset:"1",value:Buffer.from(JSON.stringify({
        kind:"FollowAdd",canonicalIntentId:"internal-1",
        sourceProtocol:"activitypods",
        actor:{webId:"https://paper.example.test/alice"},
        createdAt:"2026-11-12T00:00:00.000Z"
      }))
    };
    await subject.processBatch(batch);
    expect(subject.fanOut).toHaveBeenCalledTimes(1);
    expect(committed(subject)).toHaveBeenCalledTimes(1);
  });
  it("does not silently accept unexpected kinds without quarantine",async()=>{
    const subject=consumer() as unknown as {
      processBatch:(payload:unknown)=>Promise<void>;
    };
    const batch=payload();
    batch.batch.messages[0]={
      offset:"1",value:Buffer.from(JSON.stringify({
        kind:"SurpriseOperation",canonicalIntentId:"unknown-intent",
        sourceProtocol:"activitypub",actor:{webId:"https://remote.example.test/alice"},
        createdAt:"2026-11-12T00:00:00.000Z"
      }))
    };
    await expect(subject.processBatch(batch)).rejects.toThrow(/quarantine not enabled/);
    expect(committed(subject)).not.toHaveBeenCalled();
  });
});
