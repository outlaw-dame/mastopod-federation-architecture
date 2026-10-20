import { metrics } from "../metrics/index.js";
import { logger } from "../utils/logger.js";
import type { FepDispatchEvent } from "./contracts.js";
import type { Fep3ab2EventHub } from "./Fep3ab2EventHub.js";
import type { Fep3ab2ReplayStore } from "./Fep3ab2ReplayStore.js";

export interface Fep3ab2DispatcherOptions {
  maxPendingReplayPublishes?: number;
  maxConcurrentReplayPublishes?: number;
}

export class Fep3ab2Dispatcher {
  private readonly maxPendingReplayPublishes: number;
  private readonly maxConcurrentReplayPublishes: number;
  private publishTail: Promise<void> = Promise.resolve();
  private pendingReplayPublishes = 0;
  private activeReplayPublishes = 0;
  private readonly replayQueue: Array<() => void> = [];

  public constructor(
    private readonly eventHub: Fep3ab2EventHub,
    private readonly replayStore: Fep3ab2ReplayStore,
    options: Fep3ab2DispatcherOptions = {},
  ) {
    this.maxPendingReplayPublishes = Math.max(
      16,
      Math.min(options.maxPendingReplayPublishes ?? 2_048, 16_384),
    );
    this.maxConcurrentReplayPublishes = Math.max(
      1,
      Math.min(options.maxConcurrentReplayPublishes ?? 16, 128),
    );
  }

  public publish(event: FepDispatchEvent): void {
    if (!this.replayStore.shouldPersist(event)) {
      this.eventHub.publish(event);
      return;
    }

    if (this.pendingReplayPublishes >= this.maxPendingReplayPublishes) {
      logger.warn("FEP-3ab2 replay queue saturated; bypassing durable replay persistence", {
        topic: event.topic,
        event: event.event,
        pendingReplayPublishes: this.pendingReplayPublishes,
      });
      metrics.fepStreamingReplayRequestsTotal.inc({ outcome: "bypassed_queue_saturated" });
      this.eventHub.publish(event);
      return;
    }

    this.pendingReplayPublishes += 1;
    const persistence = this.scheduleReplayAppend(() => this.replayStore.append(event))
      .then((stored) => ({ stored, error: null as unknown }))
      .catch((error: unknown) => ({ stored: null, error }));

    // Redis persistence runs with bounded concurrency, but live publication
    // stays in original dispatch order. This removes the single-flight replay
    // bottleneck without allowing a later event to overtake an earlier one.
    this.publishTail = this.publishTail
      .then(async () => {
        const outcome = await persistence;
        if (outcome.error) {
          logger.error("FEP-3ab2 replay persistence failed; continuing with live delivery only", {
            topic: event.topic,
            event: event.event,
            error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          });
          metrics.fepStreamingReplayRequestsTotal.inc({ outcome: "persist_failed" });
          this.eventHub.publish(event);
          return;
        }
        const stored = outcome.stored;
        this.eventHub.publish({
          ...event,
          id: stored?.wireId ?? event.id,
        });
      })
      .catch((error: unknown) => {
        // A subscriber callback must not poison the ordered tail and suppress
        // all later events. EventHub owns per-connection closure policy; the
        // dispatcher keeps draining subsequent persisted events.
        logger.error("FEP-3ab2 live publication failed", {
          topic: event.topic,
          event: event.event,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pendingReplayPublishes = Math.max(0, this.pendingReplayPublishes - 1);
      });
  }

  public async drain(): Promise<void> {
    await this.publishTail;
  }

  private scheduleReplayAppend<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.activeReplayPublishes += 1;
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.activeReplayPublishes = Math.max(0, this.activeReplayPublishes - 1);
            this.startQueuedReplayAppends();
          });
      };
      this.replayQueue.push(run);
      this.startQueuedReplayAppends();
    });
  }

  private startQueuedReplayAppends(): void {
    while (
      this.activeReplayPublishes < this.maxConcurrentReplayPublishes
      && this.replayQueue.length > 0
    ) {
      const next = this.replayQueue.shift();
      next?.();
    }
  }
}
