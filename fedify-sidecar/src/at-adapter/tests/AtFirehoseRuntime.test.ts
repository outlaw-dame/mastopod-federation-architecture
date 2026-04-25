import { describe, expect, it, vi } from "vitest";
import { AtFirehoseRuntime } from "../firehose/AtFirehoseRuntime.js";

describe("AtFirehoseRuntime", () => {
  it("subscribes to local source topics and forwards well-formed events", async () => {
    const consumer = createMockConsumer();
    const publisher = {
      publishCommit: vi.fn().mockResolvedValue(undefined),
      publishIdentity: vi.fn().mockResolvedValue(undefined),
      publishAccount: vi.fn().mockResolvedValue(undefined),
    };

    const runtime = new AtFirehoseRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "firehose-runtime-test",
        consumerGroupId: "firehose-runtime-test",
        commitTopic: "at.commit.v1",
        identityTopic: "at.identity.v1",
        accountTopic: "at.account.v1",
      },
      publisher,
      consumerFactory: () => consumer,
    });

    await runtime.start();

    expect(consumer.subscribe).toHaveBeenCalledTimes(3);
    expect(consumer.subscribe).toHaveBeenNthCalledWith(1, { topic: "at.commit.v1" });
    expect(consumer.subscribe).toHaveBeenNthCalledWith(2, { topic: "at.identity.v1" });
    expect(consumer.subscribe).toHaveBeenNthCalledWith(3, { topic: "at.account.v1" });

    await runtime.handleTopicEvent("at.commit.v1", {
      did: "did:plc:alice",
      ops: [],
    });
    await runtime.handleTopicEvent("at.identity.v1", {
      canonicalAccountId: "acct-1",
      did: "did:plc:alice",
      handle: "alice.test",
    });
    await runtime.handleTopicEvent("at.account.v1", {
      canonicalAccountId: "acct-1",
      did: "did:plc:alice",
      status: "active",
    });
    await runtime.handleTopicEvent("at.commit.v1", {
      malformed: true,
    });

    expect(publisher.publishCommit).toHaveBeenCalledTimes(1);
    expect(publisher.publishIdentity).toHaveBeenCalledTimes(1);
    expect(publisher.publishAccount).toHaveBeenCalledTimes(1);
  });

  it("propagates publisher failures so the caller can retry", async () => {
    const runtime = new AtFirehoseRuntime({
      config: {
        brokers: ["localhost:9092"],
        clientId: "firehose-runtime-test",
        consumerGroupId: "firehose-runtime-test",
        commitTopic: "at.commit.v1",
      },
      publisher: {
        publishCommit: vi.fn().mockRejectedValue(new Error("publish failed")),
        publishIdentity: vi.fn().mockResolvedValue(undefined),
        publishAccount: vi.fn().mockResolvedValue(undefined),
      },
      consumerFactory: () => createMockConsumer(),
    });

    await expect(
      runtime.handleTopicEvent("at.commit.v1", {
        did: "did:plc:alice",
        ops: [],
      }),
    ).rejects.toThrow("publish failed");
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
