import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import net from "node:net";
import type { EventPublisher } from "../../core-domain/events/CoreIdentityEvents.js";
import type { AtFirehoseDecoder } from "../ingress/AtFirehoseDecoder.js";
import { DefaultAtFirehoseConsumer } from "../ingress/AtFirehoseConsumer.js";
import { InMemoryAtFirehoseCursorManager } from "../ingress/AtFirehoseCursorManager.js";

const path="/xrpc/com.atproto.sync.subscribeRepos";
const decoder: AtFirehoseDecoder = {
  decodeHeader(data) {
    const seq=Number(Buffer.from(data).toString("utf8"));
    if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error("Invalid test CBOR frame");
    return {seq,eventType:"#commit",did:"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"};
  },
  decodeFull() { return {}; },
};
const sockets: WebSocketServer[] = [];
const consumers: DefaultAtFirehoseConsumer[] = [];

async function serve(onConnect: (socket: import("ws").WebSocket) => void) {
  const wss=new WebSocketServer({host:"127.0.0.1",port:0,path});
  sockets.push(wss);
  await new Promise<void>((resolve,reject)=>{
    wss.once("listening",resolve);
    wss.once("error",reject);
  });
  const address=wss.address();
  if (!address || typeof address==="string") throw new Error("No listener");
  wss.on("connection", onConnect);
  return `ws://127.0.0.1:${address.port}${path}`;
}
function publishAdapter(publish: (topic:string,event:{seq:number})=>Promise<void>): EventPublisher {
  return {publish, publishBatch: async()=>undefined} as unknown as EventPublisher;
}
async function until(check:()=>boolean,ms=4000) {
  const expiry=Date.now()+ms;
  while (!check()) {
    if(Date.now()>=expiry)throw new Error("Firehose test timed out");
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
afterEach(async()=>{
  for (const consumer of consumers) await consumer.stop("fixture");
  consumers.length=0;
  for(const wss of sockets) {
    for(const socket of wss.clients)socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
  }
  sockets.length=0;
});

describe("verified Sync firehose WebSocket resource and cursor safety",()=>{
  it("serializes broker writes, pauses reads and commits only acknowledged frames",async()=>{
    const url=await serve(socket=>{
      for(const seq of [1,2,3])socket.send(Buffer.from(String(seq)));
    });
    const cursor=new InMemoryAtFirehoseCursorManager();
    const processed:number[]=[];
    let unblock: (()=>void)|undefined;
    const blocked=new Promise<void>(resolve=>{unblock=resolve;});
    const publish=vi.fn(async(topic:string,event:{seq:number})=>{
      expect(topic).toBe("at.firehose.raw.paper.v1");
      if(event.seq===1)await blocked;
      processed.push(event.seq);
    });
    const consumer=new DefaultAtFirehoseConsumer(
      decoder,cursor,publishAdapter(publish),"at.firehose.raw.paper.v1",
    );
    consumers.push(consumer);
    await consumer.start({id:"fixture",url,sourceType:"relay"});
    await until(()=>publish.mock.calls.length===1);
    await new Promise(resolve=>setTimeout(resolve,60));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await cursor.getHotCursor("fixture")).toBeNull();
    unblock?.();
    await until(()=>processed.length===3);
    expect(processed).toEqual([1,2,3]);
    expect(await cursor.getHotCursor("fixture")).toBe(3);
    await consumer.stop("fixture");
    expect(await cursor.getCommittedCursor("fixture")).toBe(3);
  });

  it("replays unacknowledged frames after broker failure without cursor advancement",async()=>{
    let connections=0;
    const url=await serve(socket=>{
      connections++;
      socket.send(Buffer.from("1"));
    });
    const cursor=new InMemoryAtFirehoseCursorManager();
    const publish=vi.fn(async(_topic:string,event:{seq:number})=>{
      if(publish.mock.calls.length===1)throw new Error("Broker temporarily unavailable");
      expect(event.seq).toBe(1);
    });
    const consumer=new DefaultAtFirehoseConsumer(decoder,cursor,publishAdapter(publish));
    consumers.push(consumer);
    await consumer.start({id:"fixture",url,sourceType:"relay"});
    await until(()=>publish.mock.calls.length>=1);
    expect(await cursor.getHotCursor("fixture")).toBeNull();
    await until(()=>publish.mock.calls.length===2,6000);
    expect(connections).toBeGreaterThanOrEqual(2);
     await new Promise(resolve=>setTimeout(resolve,35));
    expect(await cursor.getHotCursor("fixture")).toBe(1);
    await consumer.stop("fixture");
    expect(await cursor.getCommittedCursor("fixture")).toBe(1);
  },10000);

  it("terminates a stalled source without waiting for an unbounded broker promise",async()=>{
    const url=await serve(socket=>socket.send(Buffer.from("5")));
    const cursor=new InMemoryAtFirehoseCursorManager();
    let release: (()=>void)|undefined;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const publish=vi.fn(async()=>{await blocked;});
    const consumer=new DefaultAtFirehoseConsumer(decoder,cursor,
      publishAdapter(publish));
    consumers.push(consumer);
    await consumer.start({id:"fixture",url,sourceType:"relay"});
    await until(()=>publish.mock.calls.length===1);
    await consumer.stop("fixture");
    expect(await cursor.getCommittedCursor("fixture")).toBeNull();
    release?.();
    await new Promise(resolve=>setTimeout(resolve,40));
    expect(await cursor.getHotCursor("fixture")).toBeNull();
  });

  it("rejects startup if the selected verified upstream cannot complete a handshake",async()=>{
    const listener=net.createServer();
    await new Promise<void>(resolve=>listener.listen(0,"127.0.0.1",resolve));
    const address=listener.address();
    if(!address||typeof address==="string")throw Error("Missing ephemeral port");
    await new Promise<void>(resolve=>listener.close(()=>resolve()));
    const cursor=new InMemoryAtFirehoseCursorManager();
    const consumer=new DefaultAtFirehoseConsumer(decoder,cursor,
      publishAdapter(async()=>undefined));
    await expect(consumer.start({
      id:"fixture",
      url:`ws://127.0.0.1:${address.port}${path}`,
      sourceType:"relay",
    })).rejects.toThrow(/connection unavailable|initial connection deadline|closed before first handshake/);
    await consumer.stop("fixture");
    expect(await cursor.getCommittedCursor("fixture")).toBeNull();
  });

  it("ignores a stale socket error after the replacement heartbeat becomes active",async()=>{
    let connections=0;
    const url=await serve(socket=>{
      connections++;
      if(connections===1) {
        setTimeout(()=>socket.terminate(),100);
      }
    });
    const cursor=new InMemoryAtFirehoseCursorManager();
    const consumer=new DefaultAtFirehoseConsumer(decoder,cursor,publishAdapter(async()=>undefined));
    consumers.push(consumer);
    await consumer.start({id:"fixture",url,sourceType:"relay"});
    const holder=consumer as unknown as {activeConnections:Map<string,{
      ws: import("ws").WebSocket|null;
      heartbeatSocket:import("ws").WebSocket|null;
      pingInterval:NodeJS.Timeout|null;
    }>};
    const connection=holder.activeConnections.get("fixture");
    expect(connection).toBeDefined();
    const previousSocket=connection!.ws;
    expect(previousSocket).not.toBeNull();
    await until(()=>connections>=2,6500);
    await until(()=>connection!.heartbeatSocket!==null &&
      connection!.heartbeatSocket!==previousSocket && connection!.pingInterval!==null,2000);
    const currentSocket=connection!.heartbeatSocket;
    const heartbeat=connection!.pingInterval;
    // The old once(error) listener is still installed after a clean close.
    // It must never cancel the replacement connection's heartbeat.
    previousSocket!.emit("error",new Error("late error from previous connection"));
    expect(connection!.heartbeatSocket).toBe(currentSocket);
    expect(connection!.pingInterval).toBe(heartbeat);
    await consumer.stop("fixture");
    expect(connection!.pingInterval).toBeNull();
    expect(connection!.heartbeatSocket).toBeNull();
  },10000);

  it("refuses trusted topics and unencrypted non-loopback upstreams",async()=>{
    const cursor=new InMemoryAtFirehoseCursorManager();
    const publisher=publishAdapter(async()=>undefined);
    const badTopic=new DefaultAtFirehoseConsumer(decoder,cursor,publisher,"at.ingress.v1");
    await expect(badTopic.start({
      id:"bad",url:"wss://relay.example.test",sourceType:"relay",
    })).rejects.toThrow(/untrusted raw namespace/);
    const consumer=new DefaultAtFirehoseConsumer(decoder,cursor,publisher);
    await expect(consumer.start({
      id:"bad",url:"ws://relay.example.test",sourceType:"relay",
    })).rejects.toThrow(/WSS/);
  });
});
