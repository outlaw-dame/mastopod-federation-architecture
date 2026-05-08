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
  batchConcurrency?: number;
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
    partitionsConsumedConcurrently?: number;
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
  private readonly batchConcurrency: number;
  private consumer: AtIngressRuntimeConsumerLike | null = null;
  private started = false;
  private readonly startedSourceIds = new Set<string>();

  public constructor(private readonly options: AtIngressRuntimeOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.consumerFactory = options.consumerFactory ?? buildKafkaConsumerFactory(options.config);
    this.batchConcurrency = Math.max(1, Math.floor(options.config.batchConcurrency ?? 1));
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const consumer = this.consumerFactory(this.options.config.consumerGroupId);
    await consumer.connect();
    await consumer.subscribe({ topic: this.options.config.rawTopic });
    await consumer.run({
      // We manually call resolveOffset() per message inside processBatch and
      // disable kafkajs' end-of-batch auto-resolve. Auto-commit is left ON so
      // the periodic background committer (default 5 s / 100 messages) flushes
      // those resolved offsets — with autoCommit:false, commitOffsetsIfNecessary
      // is a no-op and offsets never advance. See kafkajs Consumer docs.
      autoCommit: true,
      eachBatchAutoResolve: false,
      // Process all partitions in parallel; otherwise kafkajs serialises
      // batches across partitions and a slow batch on one partition blocks
      // the others (we observed this stalling p0/p2 while p1 drained).
      partitionsConsumedConcurrently: 3,
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

    const results: Array<PromiseSettledResult<void> | undefined> = [];
    const inFlight = new Set<Promise<void>>();
    let nextToStart = 0;
    let nextToResolve = 0;
    let resolvedSinceCommit = false;

    const startNext = (): void => {
      if (nextToStart >= batch.messages.length || !isRunning() || isStale()) {
        return;
      }

      const resultIndex = nextToStart++;
      const message = batch.messages[resultIndex];
      if (!message) {
        return;
      }
      const task = this.processMessage(batch.topic, message)
        .then(() => {
          results[resultIndex] = { status: "fulfilled", value: undefined };
        })
        .catch((reason: unknown) => {
          results[resultIndex] = { status: "rejected", reason };
        })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    };

    while (nextToResolve < batch.messages.length) {
      if (!isRunning() || isStale()) {
        return;
      }

      while (inFlight.size < this.batchConcurrency && nextToStart < batch.messages.length) {
        startNext();
      }

      if (!results[nextToResolve]) {
        if (inFlight.size === 0) {
          return;
        }
        await Promise.race(inFlight);
        await heartbeat();
        continue;
      }

      while (results[nextToResolve]) {
        const result = results[nextToResolve];
        const message = batch.messages[nextToResolve];
        if (!result || !message) {
          break;
        }
        if (result.status === "rejected") {
          throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        }
        resolveOffset(message.offset);
        resolvedSinceCommit = true;
        nextToResolve++;
      }

      if (resolvedSinceCommit) {
        await commitOffsetsIfNecessary();
        resolvedSinceCommit = false;
      }
      await heartbeat();
    }
  }

  private async processMessage(topic: string, message: { offset: string; value: Buffer | Uint8Array | null }): Promise<void> {
    const value = readMessageValue(message.value);
    if (!value) {
      return;
    }

    let handled = true;
    try {
      handled = await this.handleRawEnvelope(JSON.parse(value));
    } catch (error) {
      this.logger.error("AT ingress runtime failed while handling a raw firehose envelope", {
        topic,
        offset: message.offset,
        error: asErrorMessage(error),
      });
      throw error;
    }

    if (!handled) {
      throw new Error("AT ingress verifier requested a retry");
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
    // Live AT firehose verifier work (CBOR decode + signature verify) can
    // block the event loop for several seconds on large commits. Give the
    // group coordinator enough headroom to avoid spurious rebalances that
    // throw away resolved-but-uncommitted offsets.
    sessionTimeout: 60_000,
    heartbeatInterval: 5_000,
    rebalanceTimeout: 90_000,
    // Cap per-partition fetch so a single batch doesn't take so long to
    // process that we miss the heartbeat window or back up other partitions.
    maxBytesPerPartition: 256 * 1024,
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
