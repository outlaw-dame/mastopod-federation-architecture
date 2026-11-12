import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { AtJetstreamService, UNVERIFIED_JETSTREAM_TOPIC } from "../jetstream/AtJetstreamService.js";

const microseconds = 1780000000000000;
const frame = (us = microseconds) => JSON.stringify({
  kind: "commit",
  time_us: us,
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  commit: {
    collection: "app.bsky.feed.post",
    rkey: "3labc",
    rev: "3labc",
    operation: "create",
    cid: "bafyreiaaaaaaaaaaaaaa",
    record: { "$type": "app.bsky.feed.post", text: "test" },
  },
});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let server: WebSocketServer | null = null;
let service: AtJetstreamService | null = null;
async function listen(): Promise<{server:WebSocketServer;url:string}> {
  const wss = new WebSocketServer({host:"127.0.0.1",port:0,path:"/subscribe"});
  await new Promise<void>((resolve,reject)=>{
    wss.once("listening",resolve);
    wss.once("error",reject);
  });
  const address=wss.address();
  if (!address || typeof address==="string") throw Error("Missing local socket address");
  server=wss;
  return {server:wss,url:`ws://127.0.0.1:${address.port}/subscribe`};
}
async function until(what:()=>boolean,ms=3500) {
  const expires=Date.now()+ms;
  while(!what()){
    if(Date.now()>=expires)throw Error("WebSocket integration acceptance timed out");
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
afterEach(async()=>{
  service?.shutdown();
  service=null;
  if(server){
    const wss=server;server=null;
    for(const client of wss.clients)client.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
  }
  vi.clearAllMocks();
});

describe("Jetstream real WebSocket backpressure and cursor recovery",()=>{
  it("pauses socket consumption while a slow Redpanda publish is outstanding",async()=>{
    const {server:wss,url}=await listen();
    let release: (()=>void)|undefined;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const publish=vi.fn(async(_topic:string,_event:unknown)=>{await blocked;});
    service=new AtJetstreamService({publish},{
      url,publishTopic:UNVERIFIED_JETSTREAM_TOPIC,maxEvents:1
    },logger);
    wss.on("connection",socket=>{
      for(let i=0;i<64;i++)socket.send(frame(microseconds+i));
    });
    service.start();
    await until(()=>publish.mock.calls.length>0);
    await new Promise(resolve=>setTimeout(resolve,90));
    expect(publish).toHaveBeenCalledTimes(1);
    expect((service as unknown as {pendingFrames:number}).pendingFrames).toBeLessThanOrEqual(8);
    expect((service as unknown as {pendingBytes:number}).pendingBytes).toBeLessThanOrEqual(2*1024*1024);
    expect(publish.mock.calls[0]?.[0]).toBe(UNVERIFIED_JETSTREAM_TOPIC);
    expect(publish.mock.calls[0]?.[1]).toMatchObject({
      kind:"jetstream.commit",verified:false
    });
    release?.();
    await until(()=>((service as unknown as {forwarded:number}).forwarded)>=1);
    await until(()=>!(service as unknown as {isRunning:boolean}).isRunning);
  });
  it("reconnects from the last acknowledged timestamp with a bounded rewind",async()=>{
    const {server:wss,url}=await listen();
    const urls:string[]=[];
    const publish=vi.fn(async()=>undefined);
    service=new AtJetstreamService({publish},{
      url,publishTopic:UNVERIFIED_JETSTREAM_TOPIC
    },logger);
    wss.on("connection",(socket,request)=>{
      urls.push(request.url??"");
      if(urls.length===1){
        socket.send(frame(microseconds));
        setTimeout(()=>socket.terminate(),100);
      }
    });
    service.start();
    await until(()=>urls.length>=2,5500);
    expect(publish).toHaveBeenCalledTimes(1);
    const second=new URL(urls[1]!,url);
    expect(second.searchParams.get("cursor"))
      .toBe(String(microseconds-5_000_000));
  });
  it("never advances the resume cursor after Redpanda publish failure",async()=>{
    const {server:wss,url}=await listen();
    const urls:string[]=[];
    const publish=vi.fn(async()=>{throw Error("synthetic broker outage");});
    service=new AtJetstreamService({publish},{
      url,publishTopic:UNVERIFIED_JETSTREAM_TOPIC
    },logger);
    wss.on("connection",(socket,request)=>{
      urls.push(request.url??"");
      if(urls.length===1)socket.send(frame());
    });
    service.start();
    await until(()=>urls.length>=2,5500);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(new URL(urls[1]!,url).searchParams.has("cursor")).toBe(false);
    expect((service as unknown as {lastPublishedTimeUs:number|null}).lastPublishedTimeUs).toBeNull();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("synthetic broker outage");
  });
});
