import type { Redis } from "ioredis";
import { logger } from "../utils/logger.js";
import { FepPrivateRealtimeMessageSchema, type FepPrivateRealtimeMessage } from "./contracts.js";

export class Fep3ab2PrivateRealtimeSubscriber {
  private readonly subscriber: Redis;
  private started = false;

  public constructor(
    redis: Redis,
    private readonly channel: string,
    private readonly handler: (message: FepPrivateRealtimeMessage) => void,
  ) {
    this.subscriber = redis.duplicate();
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.subscriber.on("message", (channel, message) => {
      if (channel !== this.channel) {
        return;
      }

      try {
        const parsed = FepPrivateRealtimeMessageSchema.parse(JSON.parse(message));
        this.handler(parsed);
      } catch (error) {
        logger.warn("FEP-3ab2 private realtime message parse failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await this.subscriber.subscribe(this.channel);
    this.started = true;
  }

  public async close(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      await this.subscriber.unsubscribe(this.channel);
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
    this.started = false;
  }
}
