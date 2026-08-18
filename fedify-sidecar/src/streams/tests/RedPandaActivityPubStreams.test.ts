import { describe, expect, it, vi } from "vitest";
import { CompressionTypes } from "kafkajs";
import {
  RedPandaProducer,
  type ActivityEvent,
  type RedPandaConfig,
} from "../redpanda-producer.js";

type TopicMessageBatch = {
  topicMessages: Array<{
    topic: string;
    messages: Array<{ value: string }>;
  }>;
};

type TopicSend = {
  topic: string;
};

const config: RedPandaConfig = {
  brokers: ["127.0.0.1:19092"],
  clientId: "redpanda-stream-semantics-test",
  connectionTimeout: 1_000,
  requestTimeout: 1_000,
  stream1Topic: "ap.stream1.local-public.v1",
  stream2Topic: "ap.stream2.remote-public.v1",
  firehoseTopic: "ap.firehose.v1",
  tombstoneTopic: "ap.tombstones.v1",
  compressionType: CompressionTypes.GZIP,
  batchSize: 16_384,
  lingerMs: 5,
};

function makeProducer() {
  const producer = new RedPandaProducer(config) as any;
  const sendBatch = vi.fn(async (_input: TopicMessageBatch) => undefined);
  const send = vi.fn(async (_input: TopicSend) => undefined);
  producer.producer = { sendBatch, send };
  return { producer: producer as RedPandaProducer, sendBatch, send };
}

function requireFirstCall<T>(calls: Array<[T]>, label: string): T {
  const first = calls[0];
  if (!first) throw new Error(`${label} was not called`);
  return first[0];
}

function requireTopicEntry(call: TopicMessageBatch, index: number) {
  const entry = call.topicMessages[index];
  if (!entry) throw new Error(`Missing topicMessages[${index}]`);
  return entry;
}

function requireFirstMessage(entry: TopicMessageBatch["topicMessages"][number]) {
  const message = entry.messages[0];
  if (!message) throw new Error(`Topic ${entry.topic} has no message`);
  return message;
}

function localEvent(): ActivityEvent {
  return {
    activity: {
      id: "https://local.example/alice/activities/1",
      type: "Create",
      actor: "https://local.example/alice",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: "https://local.example/alice/notes/1",
        type: "Note",
        content: "local",
      },
    },
    actorUri: "https://local.example/alice",
    publishedAt: 1_700_000_000_000,
    origin: "local",
    outboxIntentId: "intent-local-1",
  };
}

function remoteEvent(): ActivityEvent {
  return {
    activity: {
      id: "https://remote.example/bob/activities/1",
      type: "Create",
      actor: "https://remote.example/bob",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: "https://remote.example/bob/notes/1",
        type: "Note",
        content: "remote",
      },
    },
    actorUri: "https://remote.example/bob",
    receivedAt: 1_700_000_000_100,
    origin: "remote",
    delivery: {
      forwarding: "attempted",
      recipientCount: 1,
      localRecipientCount: 1,
    },
  };
}

describe("ActivityPub RedPanda stream semantics", () => {
  it("publishes a local public event to Stream1 and the AP firehose only", async () => {
    const { producer, sendBatch, send } = makeProducer();

    await producer.publishToStream1(localEvent());

    expect(send).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const call = requireFirstCall(sendBatch.mock.calls, "sendBatch");
    expect(call.topicMessages.map(entry => entry.topic)).toEqual([
      config.stream1Topic,
      config.firehoseTopic,
    ]);
    expect(call.topicMessages.some(entry => entry.topic === config.stream2Topic)).toBe(false);

    const stream1 = requireTopicEntry(call, 0);
    const firehose = requireTopicEntry(call, 1);
    expect(stream1.messages).toEqual(firehose.messages);
    const payload = JSON.parse(requireFirstMessage(stream1).value);
    expect(payload.origin).toBe("local");
    expect(payload.activity.id).toBe("https://local.example/alice/activities/1");
  });

  it("publishes a remote public event to Stream2 and the AP firehose only", async () => {
    const { producer, sendBatch, send } = makeProducer();

    await producer.publishToStream2(remoteEvent());

    expect(send).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const call = requireFirstCall(sendBatch.mock.calls, "sendBatch");
    expect(call.topicMessages.map(entry => entry.topic)).toEqual([
      config.stream2Topic,
      config.firehoseTopic,
    ]);
    expect(call.topicMessages.some(entry => entry.topic === config.stream1Topic)).toBe(false);

    const stream2 = requireTopicEntry(call, 0);
    const firehose = requireTopicEntry(call, 1);
    expect(stream2.messages).toEqual(firehose.messages);
    const payload = JSON.parse(requireFirstMessage(stream2).value);
    expect(payload.origin).toBe("remote");
    expect(payload.activity.id).toBe("https://remote.example/bob/activities/1");
  });

  it("keeps tombstones separate from the AP firehose", async () => {
    const { producer, sendBatch, send } = makeProducer();

    await producer.publishTombstone({
      activityId: "https://local.example/alice/activities/delete-1",
      objectId: "https://local.example/alice/notes/1",
      actorUri: "https://local.example/alice",
      deletedAt: 1_700_000_000_200,
    });

    expect(sendBatch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const call = requireFirstCall(send.mock.calls, "send");
    expect(call.topic).toBe(config.tombstoneTopic);
  });

  it("publishes local batches to Stream1 plus the AP firehose without Stream2 contamination", async () => {
    const { producer, sendBatch } = makeProducer();

    await producer.publishBatchToStream1([
      localEvent(),
      {
        ...localEvent(),
        activity: {
          ...localEvent().activity,
          id: "https://local.example/alice/activities/2",
        },
        outboxIntentId: "intent-local-2",
      },
    ]);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const call = requireFirstCall(sendBatch.mock.calls, "sendBatch");
    expect(call.topicMessages.map(entry => entry.topic)).toEqual([
      config.stream1Topic,
      config.firehoseTopic,
    ]);
    const stream1 = requireTopicEntry(call, 0);
    const firehose = requireTopicEntry(call, 1);
    expect(stream1.messages).toHaveLength(2);
    expect(firehose.messages).toEqual(stream1.messages);
  });
});
