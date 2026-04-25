import { metrics } from "../metrics/index.js";
import { logger } from "../utils/logger.js";
import type { FepDispatchEvent } from "./contracts.js";
import type { Fep3ab2EventHub } from "./Fep3ab2EventHub.js";
import type { Fep3ab2ReplayStore } from "./Fep3ab2ReplayStore.js";

export interface Fep3ab2DispatcherOptions {
  maxPendingReplayPublishes?: number;
}

export class Fep3ab2Dispatcher {
  private readonly maxPendingReplayPublishes: number;
  private replayTail: Promise<void> = Promise.resolve();
  private pendingReplayPublishes = 0;

  public constructor(
    private readonly eventHub: Fep3ab2EventHub,
    private readonly replayStore: Fep3ab2ReplayStore,
    options: Fep3ab2DispatcherOptions = {},
  ) {
    this.maxPendingReplayPublishes = Math.max(
      16,
      Math.min(options.maxPendingReplayPublishes ?? 2_048, 16_384),
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
    this.replayTail = this.replayTail
      .then(async () => {
        const stored = await this.replayStore.append(event);
        this.eventHub.publish({
          ...event,
          id: stored?.wireId ?? event.id,
        });
      })
      .catch((error: unknown) => {
        logger.error("FEP-3ab2 replay persistence failed; continuing with live delivery only", {
          topic: event.topic,
          event: event.event,
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.fepStreamingReplayRequestsTotal.inc({ outcome: "persist_failed" });
        this.eventHub.publish(event);
      })
      .finally(() => {
        this.pendingReplayPublishes = Math.max(0, this.pendingReplayPublishes - 1);
      });
  }
}
