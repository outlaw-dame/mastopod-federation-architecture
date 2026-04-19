import { describe, expect, it } from "vitest";
import {
  Fep3ab2ReplayStore,
  buildReplayEventId,
  parseReplayEventId,
} from "../Fep3ab2ReplayStore.js";
import { MemoryRedis } from "./MemoryRedis.js";

describe("Fep3ab2ReplayStore", () => {
  it("stores and replays matching public events after a replay cursor", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2ReplayStore(redis as any, {
      prefix: "test-fep",
      ttlSec: 300,
      maxReplayEvents: 10,
      maxIndexSize: 100,
    });

    const first = await store.append({
      topic: "server.example/note/1",
      event: "activitypub",
      data: {
        topic: "server.example/note/1",
        payload: { id: "https://server.example/note/1", type: "Note" },
      },
    });
    const second = await store.append({
      topic: "server.example/note/2",
      event: "activitypub",
      data: {
        topic: "server.example/note/2",
        payload: { id: "https://server.example/note/2", type: "Note" },
      },
    });

    expect(first?.wireId).toBe(buildReplayEventId(first?.sequence ?? 0));
    expect(parseReplayEventId(first?.wireId)).toBe(first?.sequence);

    const replayed = await store.replayAfter(first?.wireId, ["server.example/note/#"]);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.sequence).toBe(second?.sequence);
    expect(replayed[0]?.topic).toBe("server.example/note/2");
  });

  it("skips private or non-replayable events", async () => {
    const redis = new MemoryRedis();
    const store = new Fep3ab2ReplayStore(redis as any, {
      prefix: "test-fep",
      ttlSec: 300,
    });

    const privateRecord = await store.append({
      topic: "feeds/personal",
      event: "feed",
      principal: "https://example.com/users/alice",
      data: {
        topic: "feeds/personal",
        reason: "created",
      },
    });

    expect(privateRecord).toBeNull();
    expect(await store.replayAfter(buildReplayEventId(1), ["feeds/personal"])).toEqual([]);
  });
});
