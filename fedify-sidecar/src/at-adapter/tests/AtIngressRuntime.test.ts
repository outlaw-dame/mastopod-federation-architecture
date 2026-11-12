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

  it("releases previously started source sockets after a later source fails",async()=>{
    const broker=createMockConsumer();
    const firehoseConsumer={
      start:vi.fn(async(source:{id:string})=>{
        if(source.id==="second")throw new Error("second source unavailable");
      }),
      stop:vi.fn(async()=>undefined),
    };
    const runtime=new AtIngressRuntime({
      config:{
        brokers:["localhost:9092"],clientId:"test",
        consumerGroupId:"test",rawTopic:"at.firehose.raw.v1",
        sources:[
          {id:"first",url:"wss://one.example.test",sourceType:"relay"},
          {id:"second",url:"wss://two.example.test",sourceType:"relay"},
        ],
      },
      firehoseConsumer,
      verifier:{handleRawEvent:vi.fn().mockResolvedValue(true)},
      consumerFactory:()=>broker,
    });
    await expect(runtime.start()).rejects.toThrow(/second source/);
    expect(firehoseConsumer.stop).toHaveBeenCalledExactlyOnceWith("first");
    expect(broker.stop).toHaveBeenCalledTimes(1);
    expect(broker.disconnect).toHaveBeenCalledTimes(1);
    await runtime.stop();
    expect(firehoseConsumer.stop).toHaveBeenCalledTimes(1);
  });

  it("commits malformed raw JSON without trapping the Kafka partition",async()=>{
    const consumer=createMockConsumer();
    const verifier={handleRawEvent:vi.fn().mockResolvedValue(true)};
    const runtime=new AtIngressRuntime({
      config:{ brokers:["localhost:9092"],clientId:"test",
        consumerGroupId:"test",rawTopic:"at.firehose.raw.v1",
        sources:[{id:"configured",url:"wss://relay.example",sourceType:"relay"}],
      },
      firehoseConsumer:{start:vi.fn().mockResolvedValue(undefined),
        stop:vi.fn().mockResolvedValue(undefined)},
      verifier,
      consumerFactory:()=>consumer,
    });
    await runtime.start();
    const runConfig=consumer.run.mock.calls[0]?.[0] as {
      eachBatch:(payload:unknown)=>Promise<void>,
    };
    const resolveOffset=vi.fn(),heartbeat=vi.fn(async()=>undefined),
      commitOffsetsIfNecessary=vi.fn(async()=>undefined);
    await runConfig.eachBatch({
      batch:{topic:"at.firehose.raw.v1",messages:[
        {offset:"0",value:Buffer.from("{invalid-json")},
      ]},
      resolveOffset,heartbeat,commitOffsetsIfNecessary,
      isRunning:()=>true,isStale:()=>false,
    });
    expect(resolveOffset).toHaveBeenCalledWith("0");
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(commitOffsetsIfNecessary).toHaveBeenCalledTimes(1);
    expect(verifier.handleRawEvent).not.toHaveBeenCalled();
    await runtime.stop();
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
        sources: [{ id: "configured", url: "wss://relay.example", sourceType: "relay" }],
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
    await expect(runtime.handleRawEnvelope({
      seq: 2, source: "wss://unauthorized.example",
      eventType: "#commit", receivedAt: "2026-04-03T12:00:00Z",
      rawCborBase64: "AQID",
    })).resolves.toBe(true);
    await expect(runtime.handleRawEnvelope({
      seq: Number.MAX_SAFE_INTEGER + 1, source: "wss://relay.example",
      eventType: "#commit", receivedAt: "2026-04-03T12:00:00Z",
      rawCborBase64: "AQID",
    })).resolves.toBe(true);
    await expect(runtime.handleRawEnvelope({
      seq: -1, source: "wss://relay.example",
      eventType: "#info", receivedAt: "2026-04-03T12:00:00Z",
      rawCborBase64: "AQID",
    })).resolves.toBe(true);
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
