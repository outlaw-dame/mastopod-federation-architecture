import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Redis } from "ioredis";
import { RedisAtFirehoseSourceFence } from "../ingress/RedisAtFirehoseSourceFence.js";

const clients: Redis[] = [];
beforeAll(async () => {
  for (let i=0;i<4;i++) {
    const redis = new Redis(process.env["REDIS_URL"] || "redis://127.0.0.1:6379", {
      maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 2000,
    });
    clients.push(redis);
  }
  await Promise.all(clients.map(c => c.ping()));
});
afterAll(async () => {
  await Promise.all(clients.map(c => c.quit().catch(() => c.disconnect())));
});

describe("disposable Sync source-fence scaling baseline", () => {
  it("records 1/2/4-worker lease contention and acknowledged-cursor p95/p99", async () => {
    // Only the Redis Lua hot path is measured. This is NOT a broker+verified
    // firehose benchmark or a production throughput acceptance gate.
    const samples: Array<Record<string, unknown>> = [];
    for (const workers of [1,2,4]) {
      const id = "sync-fence-baseline:" + randomUUID();
      const stores = clients.slice(0, workers).map(redis =>
        new RedisAtFirehoseSourceFence(redis, 15000));
      const claims = await Promise.all(stores.map(s => s.tryAcquire(id)));
      const winners = claims.flatMap((claim, index) =>
        claim ? [{claim, index}] : []);
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      const store = stores[winner.index]!;
      const latencies: number[] = [];
      const count = 512;
      const rssBefore = process.memoryUsage().rss;
      const t0 = performance.now();
      for(let seq=1;seq<=count;seq++) {
        const t=performance.now();
        await store.markAcknowledged(id, winner.claim, seq);
        latencies.push(performance.now()-t);
        if (seq % 64 === 0) {
          await store.commit(id, winner.claim, seq);
          // Renew explicitly during the baseline so a slow shared CI runner
          // does not mistake an expired lease for a performance regression.
          expect(await store.renew(id, winner.claim)).toBe(true);
        }
      }
      const durationMs = performance.now()-t0;
      const committed = await store.getResumeCursor(id, winner.claim);
      expect(committed).toBe(count);
      await store.release(id, winner.claim);
      latencies.sort((a,b)=>a-b);
      const pct=(p:number)=>Number(latencies[Math.ceil(p*count)-1]!.toFixed(3));
      const sample={
        label:"disposable-redis-only",workers,activeSourceOwners:1,
        acknowledgedEvents:count,checkpointEvery:64,
        ackLatencyMs:{p50:pct(.50),p95:pct(.95),p99:pct(.99)},
        ackPerSecond:Number((1000*count/durationMs).toFixed(2)),
        rssDeltaBytes:process.memoryUsage().rss-rssBefore,
      };
      samples.push(sample);
      console.log("SYNC_FENCE_BASELINE "+JSON.stringify(sample));
    }
    expect(samples).toHaveLength(3);
  }, 30000);
});
