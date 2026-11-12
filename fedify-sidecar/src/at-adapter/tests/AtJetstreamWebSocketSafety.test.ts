import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import {
  AtJetstreamService, AT_JETSTREAM_UNVERIFIED_TOPIC,
  parseJetstreamUrl,
} from "../jetstream/AtJetstreamService.js";

const noLog = {info:vi.fn(),warn:vi.fn(),error:vi.fn()};
const observation = (cursor: number, operation = "create") => JSON.stringify({
  kind:"commit",did:"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  time_us:cursor,
  commit:{
    rev:"3lvtc1a",operation,
    collection:"app.bsky.feed.post",rkey:"3lvtc1a",
    cid:"bafyreigw",record:{$type:"app.bsky.feed.post",text:"test"}
  }
});
async function until(predicate:()=>boolean,ms=4500) {
  const started=Date.now();
  while(!predicate()){
    if(Date.now()-started>ms)throw Error("WebSocket proof timed out");
    await new Promise(resolve=>setTimeout(resolve,15));
  }
}
type Runtime = {server:Server;wsServer:WebSocketServer;origin:string};
const active:Runtime[]=[];
const services:AtJetstreamService[]=[];
async function serverFor(onConnection:(ws:any,url:string)=>void):Promise<Runtime>{
  const server=createServer((_req,res)=>res.writeHead(404).end());
  const wsServer=new WebSocketServer({server});
  wsServer.on("connection",(ws,req)=>onConnection(ws,req.url||""));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();
  if(!address||typeof address==="string")throw Error("listener missing");
  const runtime={server,wsServer,origin:`ws://127.0.0.1:${address.port}`};
  active.push(runtime);return runtime;
}
afterEach(async()=>{
  for(const service of services.splice(0))service.shutdown();
  for(const fixture of active.splice(0)){
    for(const client of fixture.wsServer.clients)client.terminate();
    await new Promise<void>(resolve=>fixture.wsServer.close(()=>resolve()));
    await new Promise<void>(resolve=>fixture.server.close(()=>resolve()));
  }
  vi.clearAllMocks();
});

describe("unverified Jetstream WebSocket ingest",()=>{
  it("refuses to treat JSON as verified repository events",()=>{
    expect(()=>new AtJetstreamService({publish:vi.fn()},{
      url:"wss://jetstream.example.test/subscribe",
      publishTopic:"at.ingress.v1"
    })).toThrow(/unverified staging topic/);
    expect(()=>new AtJetstreamService({publish:vi.fn()},{
      url:"wss://jetstream.example.test/subscribe",
      publishTopic:AT_JETSTREAM_UNVERIFIED_TOPIC
    })).not.toThrow();
  });
  it("restricts non-TLS endpoints to loopback tests without echoing secrets",()=>{
    expect(parseJetstreamUrl("wss://example.test/subscribe"))
      .toBe("wss://example.test/subscribe");
    expect(parseJetstreamUrl("ws://127.0.0.1:1234/subscribe"))
      .toBe("ws://127.0.0.1:1234/subscribe");
    expect(()=>parseJetstreamUrl("ws://other.example.test/subscribe")).toThrow(/canonical WSS/);
    expect(()=>parseJetstreamUrl("wss://user:password@example.test/subscribe"))
      .toThrow(/canonical WSS/);
    expect(()=>parseJetstreamUrl("wss://example.test/subscribe#secret"))
      .toThrow(/canonical WSS/);
  });
  it("serializes broker publishes and never sets signatureValid on observations",async()=>{
    const base=1700000000000000;
    const f=await serverFor(ws=>{
      for(let i=0;i<4;i++)ws.send(observation(base+i));
    });
    let inflight=0,maxInflight=0;
    const received:number[]=[];
    const publish=vi.fn(async(topic:string,event:any)=>{
      expect(topic).toBe(AT_JETSTREAM_UNVERIFIED_TOPIC);
      expect(event.verified).toBe(false);
      expect(event.commit.signatureValid).toBeUndefined();
      inflight++;
      maxInflight=Math.max(maxInflight,inflight);
      await new Promise(resolve=>setTimeout(resolve,6));
      received.push(event.cursor);
      inflight--;
    });
    const svc=new AtJetstreamService({publish},{
      url:f.origin+"/subscribe",publishTopic:AT_JETSTREAM_UNVERIFIED_TOPIC
    },noLog);
    services.push(svc);
    svc.start();
    await until(()=>received.length===4);
    expect(received).toEqual(Array.from({length:4},(_,i)=>base+i));
    expect(maxInflight).toBe(1);
  });
  it("reconnects from the last acknowledged event after a failed broker write",async()=>{
    const base=1700000001000000;
    const urls:string[]=[];
    const f=await serverFor((ws,url)=>{
      urls.push(url);
      if(urls.length===1){
        ws.send(observation(base));
        ws.send(observation(base+1));
      }else{
        ws.send(observation(base+1));
      }
    });
    let failOnce=true;
    const received:number[]=[];
    const publish=vi.fn(async(_topic:string,event:any)=>{
      if(event.cursor===base+1 && failOnce){
        failOnce=false;
        throw Error("test broker unavailable");
      }
      received.push(event.cursor);
    });
    const svc=new AtJetstreamService({publish},{
      url:f.origin+"/subscribe",publishTopic:AT_JETSTREAM_UNVERIFIED_TOPIC
    },noLog);
    services.push(svc);svc.start();
    await until(()=>received.includes(base+1)&&urls.length>=2,6000);
    expect(received).toEqual([base,base+1]);
    expect(new URL(urls[1]!,f.origin).searchParams.get("cursor"))
      .toBe(String(base-5000000));
  });
  it("does not interpret unknown mutation operations as creates",async()=>{
    const f=await serverFor(ws=>ws.send(observation(1700000000000001,"unknown-action")));
    const publish=vi.fn();
    const svc=new AtJetstreamService({publish},{
      url:f.origin+"/subscribe",publishTopic:AT_JETSTREAM_UNVERIFIED_TOPIC,
    },noLog);
    services.push(svc);svc.start();
    await until(()=>f.wsServer.clients.size===1);
    await new Promise(resolve=>setTimeout(resolve,70));
    expect(publish).not.toHaveBeenCalled();
  });
});
