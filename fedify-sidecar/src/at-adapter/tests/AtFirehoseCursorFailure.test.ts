import { describe, expect, it, vi } from "vitest";
import { encode } from "cborg";
import { DefaultAtFirehoseDecoder } from "../ingress/AtFirehoseDecoder.js";
import { DefaultAtFirehoseCursorManager } from "../ingress/AtFirehoseCursorManager.js";
import { RedisAtIngressCheckpointStore } from "../ingress/AtIngressCheckpointStore.js";

describe("external verified firehose fail-closed cursors",()=>{
  it("rejects corrupt committed checkpoints instead of silently tailing live",async()=>{
    const redis={get:vi.fn(async()=> "9223372036854775807"),
      set:vi.fn(async()=> "OK")};
    const store=new RedisAtIngressCheckpointStore(redis);
    await expect(store.loadCommittedCursor("relay")).rejects.toThrow(/checkpoint/);
    const manager=new DefaultAtFirehoseCursorManager(redis,store);
    await expect(manager.getResumeCursor("relay")).rejects.toThrow();
  });

  it("rejects storage outages rather than silently discarding durable cursors",async()=>{
    const redis={get:vi.fn(async():Promise<string|null>=>{
      throw new Error("redis disconnected");
    }),set:vi.fn(async()=> "OK")};
    const store=new RedisAtIngressCheckpointStore(redis);
    const manager=new DefaultAtFirehoseCursorManager(redis,store);
    await expect(manager.getResumeCursor("relay")).rejects.toThrow(/checkpoint/);
  });

  it("does not acknowledge a frame when its Redis hot cursor cannot be recorded",async()=>{
    const redis={get:vi.fn(async()=>null),
      set:vi.fn(async():Promise<string>=>{throw new Error("redis unavailable");})};
    const store=new RedisAtIngressCheckpointStore(redis);
    const manager=new DefaultAtFirehoseCursorManager(redis,store);
    await expect(manager.setHotCursor("relay",10)).rejects.toThrow(/cursor/);
  });

  it("never clamps unsafe or fractional upstream seq values into a trusted cursor",()=>{
    const decoder=new DefaultAtFirehoseDecoder();
    const frame=(seq:number) => {
      const header=encode({op:1,t:"#commit"});
      const payload=encode({seq,repo:"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"});
      return Buffer.concat([Buffer.from(header),Buffer.from(payload)]);
    };
    for(const seq of [0,-1,1.25,Number.MAX_SAFE_INTEGER+100]){
      expect(()=>decoder.decodeHeader(frame(seq))).toThrow();
    }
    expect(decoder.decodeHeader(frame(12)).seq).toBe(12);
  });
});
