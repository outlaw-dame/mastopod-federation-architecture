import { describe, expect, it, vi } from "vitest";
import {
  RedpandaEventPublisher, type KafkaProducerLike,
} from "../../core-domain/events/RedpandaEventPublisher.js";
import {
  AT_SYNC_MAX_FRAME_BYTES,
  AT_SYNC_RAW_MAX_EVENT_BYTES,
  AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES,
  AT_SYNC_RAW_FETCH_BYTES_PER_PARTITION,
  AT_SYNC_RAW_FETCH_BYTES,
} from "../ingress/AtExternalFirehosePayloadLimits.js";
import { buildTopicDefinitions } from "../../streams/redpanda-topic-governance.js";

const rawTopic = "at.firehose.raw.v1";
function mockProducer(): KafkaProducerLike {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue([]),
  };
}
function rawEvent(rawCborBase64: string) {
  return {
    seq: 1, eventType: "#commit", did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    source: "wss://relay.example.test/xrpc/com.atproto.sync.subscribeRepos",
    receivedAt: "2026-11-12T12:00:00Z", rawCborBase64,
  };
}

describe("external Sync full-frame Redpanda payload limits", () => {
  it("supports a maximum-sized raw CBOR frame without raising ordinary event limits", async () => {
    const producer = mockProducer();
    const publisher = new RedpandaEventPublisher({
      brokers: ["localhost:9092"], clientId: "large-sync-test",
      compression: "none", largeRawFirehoseTopic: rawTopic,
    }, producer);
    const encoded = Buffer.alloc(AT_SYNC_MAX_FRAME_BYTES, 0x7b).toString("base64");
    const body = rawEvent(encoded);
    await publisher.publish(rawTopic, body as any);
    expect(producer.send).toHaveBeenCalledTimes(1);
    const call = (producer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const serialized = call.messages[0].value as string;
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(AT_SYNC_RAW_MAX_EVENT_BYTES);
    expect(JSON.parse(serialized).rawCborBase64).toBe(encoded);
    expect(call.topic).toBe(rawTopic);
    expect(AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES).toBeGreaterThan(AT_SYNC_RAW_MAX_EVENT_BYTES);
    expect(AT_SYNC_RAW_FETCH_BYTES_PER_PARTITION).toBeGreaterThan(AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES);
    expect(AT_SYNC_RAW_FETCH_BYTES).toBeGreaterThan(AT_SYNC_RAW_FETCH_BYTES_PER_PARTITION);
    await expect(publisher.publish("at.ingress.v1", body as any))
      .rejects.toMatchObject({code: "SAFE_JSON_TOO_LARGE"});
    expect(producer.send).toHaveBeenCalledTimes(1);
  }, 20000);

  it("does not allow a large raw topic without explicit verified source configuration", async () => {
    const producer = mockProducer();
    const publisher = new RedpandaEventPublisher({
      brokers: ["localhost:9092"], clientId: "small-sync-test",
      compression: "none",
    }, producer);
    await expect(publisher.publish(rawTopic, rawEvent("X".repeat(600_000)) as any))
      .rejects.toMatchObject({code: "SAFE_JSON_TOO_LARGE"});
    expect(producer.send).not.toHaveBeenCalled();
  });

  it("refuses large-message budget on a canonical or unrelated topic", () => {
    expect(() => new RedpandaEventPublisher({
      brokers:["localhost:9092"], clientId:"unsafe",
      largeRawFirehoseTopic:"at.ingress.v1",
    }, mockProducer())).toThrow(/isolated raw topic namespace/);
  });

  it("governs larger messages only on enabled external raw firehose topics", () => {
    const enabled = buildTopicDefinitions("production", {
      enableVerifiedExternalFirehose:true,
    });
    const raw = enabled.find(t => t.topic === rawTopic);
    expect(raw?.maxMessageBytes).toBe(AT_SYNC_RAW_TOPIC_MAX_MESSAGE_BYTES);
    expect(enabled.filter(t => t.maxMessageBytes !== undefined))
      .toHaveLength(1);
    expect(buildTopicDefinitions("production")
      .find(t => t.topic === rawTopic)?.maxMessageBytes).toBeUndefined();
  });
});
