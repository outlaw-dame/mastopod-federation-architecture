import { describe, expect, it, vi } from "vitest";
import {
  AtJetstreamService, parseJetstreamUrl, UNVERIFIED_JETSTREAM_TOPIC,
} from "../jetstream/AtJetstreamService.js";

const url="wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&token=private";
const commit = (timeUs=1780000000000000) => JSON.stringify({
  kind:"commit",time_us:timeUs,did:"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  commit:{
    collection:"app.bsky.feed.post",rkey:"3l123",rev:"3l123",
    operation:"create",cid:"bafyreiaaaaa",
    record:{"$type":"app.bsky.feed.post",text:"hello"}
  }
});
const logger={
  info:vi.fn(),warn:vi.fn(),error:vi.fn()
};
function make(publish=vi.fn(async()=>undefined)) {
  return {
    publish,
    service:new AtJetstreamService({publish},{
      url,publishTopic:UNVERIFIED_JETSTREAM_TOPIC
    },logger)
  };
}
async function feed(service:AtJetstreamService,payload:string) {
  await (service as unknown as {
    handleMessage:(source:string)=>Promise<void>;
  }).handleMessage(payload);
}

describe("Jetstream unverified WebSocket boundary",()=>{
  it("refuses to publish a decoded stream directly to trusted ATProto ingress",()=>{
    const service=new AtJetstreamService({publish:vi.fn(async()=>undefined)},{
      url,publishTopic:"at.ingress.v1"
    });
    expect(()=>service.start()).toThrow(/cannot be published to trusted ingress/);
    expect(service).toBeTruthy();
  });
  it("requires secure, credential-free Jetstream subscribe URLs",()=>{
    expect(parseJetstreamUrl(undefined)).toMatch(/^wss:\/\//);
    for(const candidate of [
      "ws://jetstream.example.test/subscribe",
      "https://jetstream.example.test/subscribe",
      "wss://user:password@jetstream.example.test/subscribe",
      "wss://jetstream.example.test/subscribe#secret",
      "wss://jetstream.example.test/internal"
    ]) {
      expect(()=>parseJetstreamUrl(candidate)).toThrow(/Invalid JETSTREAM_URL/);
      try {parseJetstreamUrl(candidate)}
      catch(error){expect(String(error)).not.toContain("password")}
    }
  });
  it("publishes explicitly UNVERIFIED records without disclosing subscription query secrets",async()=>{
    const {publish,service}=make();
    await feed(service,commit());
    expect(publish).toHaveBeenCalledTimes(1);
    const [topic,event]=publish.mock.calls[0] as unknown as [string,Record<string,unknown>];
    expect(topic).toBe(UNVERIFIED_JETSTREAM_TOPIC);
    expect(event).toMatchObject({
      kind:"jetstream.commit",verified:false,
      timeUs:1780000000000000,
      source:"wss://jetstream1.us-east.bsky.network/subscribe",
      did:"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(JSON.stringify(event)).not.toContain("token=private");
    expect(JSON.stringify(event)).not.toContain("signatureValid");
  });
  it("never advances a cursor before the Redpanda write succeeds",async()=>{
    const publish=vi.fn(async()=>{throw new Error("redpanda unavailable")});
    const {service}=make(publish);
    await expect(feed(service,commit())).rejects.toThrow("redpanda unavailable");
    expect((service as unknown as {lastPublishedTimeUs:number|null}).lastPublishedTimeUs).toBe(null);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("token=private");
  });
  it("drops malformed timestamps and unknown operations without creating trusted messages",async()=>{
    const {publish,service}=make();
    await feed(service,commit(0));
    await feed(service,JSON.stringify({kind:"commit",did:"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",time_us:1780000000000000,commit:{collection:"app.bsky.feed.post",rkey:"abc",operation:"unknown"}}));
    await feed(service,"{invalid-json");
    expect(publish).not.toHaveBeenCalled();
  });
  it("advances only the acknowledged in-process cursor and logs in batches",async()=>{
    const {publish,service}=make();
    await feed(service,commit(1780000000000000));
    await feed(service,commit(1779999999000000));
    expect(publish).toHaveBeenCalledTimes(2);
    expect((service as unknown as {lastPublishedTimeUs:number|null}).lastPublishedTimeUs)
      .toBe(1780000000000000);
    expect(logger.info).not.toHaveBeenCalledWith("Jetstream event published",expect.anything());
  });
});
