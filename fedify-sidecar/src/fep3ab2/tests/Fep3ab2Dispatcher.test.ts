import { describe, expect, it } from "vitest";
import type { FepDispatchEvent } from "../contracts.js";
import { Fep3ab2Dispatcher } from "../Fep3ab2Dispatcher.js";

function event(sequence: number): FepDispatchEvent {
  return {
    topic: "feeds/public/remote",
    event: "activitypub",
    data: { sequence },
  };
}

describe("Fep3ab2Dispatcher", () => {
  it("persists with bounded concurrency while publishing in dispatch order", async () => {
    let active = 0;
    let maxActive = 0;
    const published: number[] = [];
    const eventHub = {
      publish(input: FepDispatchEvent) {
        published.push(input.data["sequence"] as number);
      },
    };
    const replayStore = {
      shouldPersist: () => true,
      async append(input: FepDispatchEvent) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const sequence = input.data["sequence"] as number;
        await new Promise((resolve) => setTimeout(resolve, (sequence % 4) + 1));
        active -= 1;
        return {
          sequence,
          wireId: `fep3ab2-replay-${sequence}`,
          topic: input.topic,
          event: input.event,
          data: input.data,
        };
      },
    };
    const dispatcher = new Fep3ab2Dispatcher(
      eventHub as never,
      replayStore as never,
      { maxConcurrentReplayPublishes: 4, maxPendingReplayPublishes: 64 },
    );

    for (let sequence = 1; sequence <= 32; sequence += 1) {
      dispatcher.publish(event(sequence));
    }
    await dispatcher.drain();

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(published).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
  });

  it("keeps ordered live delivery when one replay append fails", async () => {
    const published: number[] = [];
    const eventHub = {
      publish(input: FepDispatchEvent) {
        published.push(input.data["sequence"] as number);
      },
    };
    const replayStore = {
      shouldPersist: () => true,
      async append(input: FepDispatchEvent) {
        const sequence = input.data["sequence"] as number;
        if (sequence === 2) throw new Error("isolated replay failure");
        return {
          sequence,
          wireId: `fep3ab2-replay-${sequence}`,
          topic: input.topic,
          event: input.event,
          data: input.data,
        };
      },
    };
    const dispatcher = new Fep3ab2Dispatcher(
      eventHub as never,
      replayStore as never,
      { maxConcurrentReplayPublishes: 3 },
    );

    dispatcher.publish(event(1));
    dispatcher.publish(event(2));
    dispatcher.publish(event(3));
    await dispatcher.drain();

    expect(published).toEqual([1, 2, 3]);
  });

  it("does not let one throwing subscriber poison the ordered tail", async () => {
    const attempted: number[] = [];
    const eventHub = {
      publish(input: FepDispatchEvent) {
        const sequence = input.data["sequence"] as number;
        attempted.push(sequence);
        if (sequence === 2) throw new Error("subscriber failed");
      },
    };
    const replayStore = {
      shouldPersist: () => true,
      async append(input: FepDispatchEvent) {
        const sequence = input.data["sequence"] as number;
        return {
          sequence,
          wireId: `fep3ab2-replay-${sequence}`,
          topic: input.topic,
          event: input.event,
          data: input.data,
        };
      },
    };
    const dispatcher = new Fep3ab2Dispatcher(eventHub as never, replayStore as never);

    dispatcher.publish(event(1));
    dispatcher.publish(event(2));
    dispatcher.publish(event(3));
    await dispatcher.drain();

    expect(attempted).toEqual([1, 2, 3]);
  });
});
