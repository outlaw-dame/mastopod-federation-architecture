import { Kafka, logLevel, type Consumer, type EachBatchPayload } from "kafkajs";
import type { AtCommitV1 } from "../events/AtRepoEvents.js";
import type { AtIdentityV1, AtAccountV1 } from "../../core-domain/events/CoreIdentityEvents.js";
import type { AtFirehosePublisher } from "./AtFirehosePublisher.js";

export interface AtFirehoseRuntimeConfig {
  brokers: string[];
  clientId: string;
  consumerGroupId: string;
  commitTopic: string;
  identityTopic?: string | null;
  accountTopic?: string | null;
}

export interface AtFirehoseRuntimeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AtFirehoseRuntimeConsumerLike {
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

export interface AtFirehoseRuntimeOptions {
  config: AtFirehoseRuntimeConfig;
  publisher: AtFirehosePublisher;
  logger?: AtFirehoseRuntimeLogger;
  consumerFactory?: (groupId: string) => AtFirehoseRuntimeConsumerLike;
}

const NOOP_LOGGER: AtFirehoseRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class AtFirehoseRuntime {
  private readonly logger: AtFirehoseRuntimeLogger;
  private readonly consumerFactory: (groupId: string) => AtFirehoseRuntimeConsumerLike;
  private consumer: AtFirehoseRuntimeConsumerLike | null = null;
  private started = false;

  public constructor(private readonly options: AtFirehoseRuntimeOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.consumerFactory = options.consumerFactory ?? buildKafkaConsumerFactory(options.config);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const topics = [
      this.options.config.commitTopic,
      this.options.config.identityTopic ?? null,
      this.options.config.accountTopic ?? null,
    ].filter((topic): topic is string => typeof topic === "string" && topic.length > 0);

    if (topics.length === 0) {
      this.logger.warn("AT firehose runtime not started because no source topics were configured");
      return;
    }

    const consumer = this.consumerFactory(this.options.config.consumerGroupId);
    await consumer.connect();
    for (const topic of topics) {
      await consumer.subscribe({ topic });
    }
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        await this.processBatch(payload);
      },
    });

    this.consumer = consumer;
    this.started = true;
    this.logger.info("AT firehose runtime started", {
      topics,
      consumerGroupId: this.options.config.consumerGroupId,
    });
  }

  public async stop(): Promise<void> {
    if (!this.consumer) {
      this.started = false;
      return;
    }

    try {
      await this.consumer.stop();
    } finally {
      try {
        await this.consumer.disconnect();
      } finally {
        this.consumer = null;
        this.started = false;
      }
    }
  }

  public async handleTopicEvent(topic: string, event: unknown): Promise<void> {
    if (topic === this.options.config.commitTopic) {
      const commit = asAtCommitEvent(event);
      if (!commit) {
        this.logger.warn("Dropping malformed at.commit.v1 event before firehose publish", { topic });
        return;
      }
      await this.options.publisher.publishCommit(commit);
      return;
    }

    if (topic === this.options.config.identityTopic) {
      const identity = asAtIdentityEvent(event);
      if (!identity) {
        this.logger.warn("Dropping malformed at.identity.v1 event before firehose publish", { topic });
        return;
      }
      await this.options.publisher.publishIdentity(identity);
      return;
    }

    if (topic === this.options.config.accountTopic) {
      const account = asAtAccountEvent(event);
      if (!account) {
        this.logger.warn("Dropping malformed at.account.v1 event before firehose publish", { topic });
        return;
      }
      await this.options.publisher.publishAccount(account);
      return;
    }

    this.logger.warn("AT firehose runtime received an unexpected topic", { topic });
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

      try {
        await this.handleTopicEvent(batch.topic, JSON.parse(value));
      } catch (error) {
        this.logger.error("AT firehose runtime failed to publish a local event", {
          topic: batch.topic,
          offset: message.offset,
          error: asErrorMessage(error),
        });
        throw error;
      }

      resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
    }
  }
}

function buildKafkaConsumerFactory(
  config: AtFirehoseRuntimeConfig,
): (groupId: string) => Consumer {
  const kafka = new Kafka({
    clientId: `${config.clientId}-at-firehose`,
    brokers: config.brokers,
    logLevel: logLevel.WARN,
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  });

  return (groupId: string) => kafka.consumer({
    groupId,
    allowAutoTopicCreation: true,
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

function asAtCommitEvent(event: unknown): AtCommitV1 | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  return typeof candidate["did"] === "string" && Array.isArray(candidate["ops"])
    ? event as AtCommitV1
    : null;
}

function asAtIdentityEvent(event: unknown): AtIdentityV1 | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  return typeof candidate["canonicalAccountId"] === "string"
    && typeof candidate["did"] === "string"
    && typeof candidate["handle"] === "string"
    ? event as AtIdentityV1
    : null;
}

function asAtAccountEvent(event: unknown): AtAccountV1 | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  return typeof candidate["canonicalAccountId"] === "string"
    && typeof candidate["did"] === "string"
    && typeof candidate["status"] === "string"
    ? event as AtAccountV1
    : null;
}
