import { Kafka, logLevel, type Consumer, type EachBatchPayload } from "kafkajs";
import type { CanonicalV1Event } from "../../streams/v6-topology.js";

export interface CanonicalReportEventConsumerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface CanonicalReportEventConsumerConfig {
  brokers: string[];
  clientId: string;
  consumerGroupId: string;
  canonicalTopic: string;
  consumerName: string;
}

export interface CanonicalReportEventHandler {
  handleCanonicalEvent(event: CanonicalV1Event): Promise<unknown>;
}

const NOOP_LOGGER: CanonicalReportEventConsumerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class CanonicalReportEventConsumer {
  private consumer: Consumer | null = null;
  private running = false;

  constructor(
    private readonly config: CanonicalReportEventConsumerConfig,
    private readonly handler: CanonicalReportEventHandler,
    private readonly logger: CanonicalReportEventConsumerLogger = NOOP_LOGGER,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const kafka = new Kafka({
      clientId: `${this.config.clientId}-${this.config.consumerName}`,
      brokers: this.config.brokers,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 100, retries: 8 },
    });

    this.consumer = kafka.consumer({
      groupId: this.config.consumerGroupId,
      allowAutoTopicCreation: false,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.config.canonicalTopic });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        await this.processBatch(payload);
      },
    });

    this.logger.info(`${this.config.consumerName} started`, {
      topic: this.config.canonicalTopic,
      groupId: this.config.consumerGroupId,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.consumer) {
      try {
        await this.consumer.stop();
      } catch {
        // best-effort shutdown
      }
      try {
        await this.consumer.disconnect();
      } catch {
        // best-effort shutdown
      }
      this.consumer = null;
    }
  }

  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const {
      batch,
      resolveOffset,
      heartbeat,
      commitOffsetsIfNecessary,
      isRunning,
      isStale,
    } = payload;

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;

      const raw = message.value?.toString("utf8")?.trim();
      if (!raw) {
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      let event: CanonicalV1Event;
      try {
        event = JSON.parse(raw) as CanonicalV1Event;
      } catch {
        this.logger.warn(`${this.config.consumerName} message could not be parsed — skipping`, {
          offset: message.offset,
        });
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      try {
        await this.handler.handleCanonicalEvent(event);
      } catch (error) {
        this.logger.error(`${this.config.consumerName} failed; leaving offset uncommitted`, {
          offset: message.offset,
          canonicalIntentId: event.canonicalIntentId,
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        await heartbeat();
        throw error;
      }

      resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
    }
  }
}
