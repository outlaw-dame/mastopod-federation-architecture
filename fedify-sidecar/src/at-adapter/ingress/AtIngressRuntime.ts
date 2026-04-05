import { Kafka, logLevel, type Consumer, type EachBatchPayload } from "kafkajs";
import type { AtFirehoseRawEnvelope } from "./AtIngressEvents.js";
import type { AtFirehoseConsumer, AtFirehoseSource } from "./AtFirehoseConsumer.js";
import type { AtIngressVerifier } from "./AtIngressVerifier.js";

export interface AtIngressRuntimeConfig {
  brokers: string[];
  clientId: string;
  consumerGroupId: string;
  rawTopic: string;
  sources: AtFirehoseSource[];
}

export interface AtIngressRuntimeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AtIngressRuntimeConsumerLike {
  connect(): Promise<void>;
  subscribe(subscription: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(config: {
    autoCommit?: boolean;
    eachBatchAutoResolve?: boolean;
    eachBatch(payload: EachBatchPayload): Promise<void>;
  }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface AtIngressRuntimeOptions {
  config: AtIngressRuntimeConfig;
  firehoseConsumer: AtFirehoseConsumer;
  verifier: AtIngressVerifier;
  logger?: AtIngressRuntimeLogger;
  consumerFactory?: (groupId: string) => AtIngressRuntimeConsumerLike;
}

const NOOP_LOGGER: AtIngressRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class AtIngressRuntime {
  private readonly logger: AtIngressRuntimeLogger;
  private readonly consumerFactory: (groupId: string) => AtIngressRuntimeConsumerLike;
  private consumer: AtIngressRuntimeConsumerLike | null = null;
  private started = false;
  private readonly startedSourceIds = new Set<string>();

  public constructor(private readonly options: AtIngressRuntimeOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.consumerFactory = options.consumerFactory ?? buildKafkaConsumerFactory(options.config);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const consumer = this.consumerFactory(this.options.config.consumerGroupId);
    await consumer.connect();
    await consumer.subscribe({ topic: this.options.config.rawTopic });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        await this.processBatch(payload);
      },
    });

    try {
      for (const source of this.options.config.sources) {
        await this.options.firehoseConsumer.start(source);
        this.startedSourceIds.add(source.id);
      }
    } catch (error) {
      await consumer.stop().catch(() => undefined);
      await consumer.disconnect().catch(() => undefined);
      this.consumer = null;
      throw error;
    }

    this.consumer = consumer;
    this.started = true;
    this.logger.info("AT ingress runtime started", {
      rawTopic: this.options.config.rawTopic,
      sources: this.options.config.sources.map((source) => source.id),
    });
  }

  public async stop(): Promise<void> {
    for (const sourceId of Array.from(this.startedSourceIds)) {
      try {
        await this.options.firehoseConsumer.stop(sourceId);
      } finally {
        this.startedSourceIds.delete(sourceId);
      }
    }

    if (this.consumer) {
      try {
        await this.consumer.stop();
      } finally {
        try {
          await this.consumer.disconnect();
        } finally {
          this.consumer = null;
        }
      }
    }

    this.started = false;
  }

  public async handleRawEnvelope(event: unknown): Promise<boolean> {
    const envelope = asAtFirehoseRawEnvelope(event);
    if (!envelope) {
      this.logger.warn("Dropping malformed at.firehose.raw.v1 envelope");
      return true;
    }

    return this.options.verifier.handleRawEvent(envelope);
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
      if (!isRunning() || isStale()) {
        return;
      }

      const value = readMessageValue(message.value);
      if (!value) {
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      let handled = true;
      try {
        handled = await this.handleRawEnvelope(JSON.parse(value));
      } catch (error) {
        this.logger.error("AT ingress runtime failed while handling a raw firehose envelope", {
          topic: batch.topic,
          offset: message.offset,
          error: asErrorMessage(error),
        });
        throw error;
      }

      if (!handled) {
        throw new Error("AT ingress verifier requested a retry");
      }

      resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
    }
  }
}

function buildKafkaConsumerFactory(
  config: AtIngressRuntimeConfig,
): (groupId: string) => Consumer {
  const kafka = new Kafka({
    clientId: `${config.clientId}-at-ingress`,
    brokers: config.brokers,
    logLevel: logLevel.WARN,
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  });

  return (groupId: string) => kafka.consumer({
    groupId,
    allowAutoTopicCreation: false,
  });
}

function readMessageValue(value: Buffer | Uint8Array | null): string | null {
  if (!value) {
    return null;
  }
  return Buffer.from(value).toString("utf8");
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asAtFirehoseRawEnvelope(event: unknown): AtFirehoseRawEnvelope | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  return typeof candidate["source"] === "string"
    && typeof candidate["rawCborBase64"] === "string"
    && typeof candidate["eventType"] === "string"
    && typeof candidate["receivedAt"] === "string"
    && typeof candidate["seq"] === "number"
    ? event as AtFirehoseRawEnvelope
    : null;
}
