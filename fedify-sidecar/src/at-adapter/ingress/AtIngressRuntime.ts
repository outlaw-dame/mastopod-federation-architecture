import { Kafka, logLevel, type Consumer, type EachBatchPayload } from "kafkajs";
import type { AtFirehoseRawEnvelope } from "./AtIngressEvents.js";
import type { AtFirehoseConsumer, AtFirehoseSource } from "./AtFirehoseConsumer.js";
import type { AtIngressVerifier } from "./AtIngressVerifier.js";
import { ensureRedpandaCompressionCodec } from "../../streams/kafka-compression.js";

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
  private readonly acceptedSources: ReadonlySet<string>;

  public constructor(private readonly options: AtIngressRuntimeOptions) {
    // The raw Kafka topic is untrusted. Only a configured upstream URL may
    // drive Redis replay tracking or the cryptographic verification pipeline.
    this.acceptedSources = new Set(options.config.sources.map(s => s.url));
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
      // Partially started source sockets must not survive a failed startup.
      // Otherwise later retries run duplicate consumers for the same stream.
      for (const sourceId of this.startedSourceIds) {
        await this.options.firehoseConsumer.stop(sourceId).catch(() => undefined);
      }
      this.startedSourceIds.clear();
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

    if (!this.acceptedSources.has(envelope.source)) {
      // Do not log attacker-supplied URLs or create per-source Redis keys.
      this.logger.warn("Dropping raw AT firehose envelope for unknown source");
      return true;
    }
    if (envelope.eventType === "#info") return true;
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

      let payload: unknown;
      try {
        payload = JSON.parse(value);
      } catch {
        // Malformed raw JSON is an untrusted transport error, not a
        // transient verifier failure. Do not strand the Kafka partition.
        this.logger.warn("Dropping non-JSON raw AT firehose envelope");
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }
      let handled = true;
      try {
        handled = await this.handleRawEnvelope(payload);
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
  ensureRedpandaCompressionCodec();

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

const RAW_EVENTS = new Set(["#commit", "#identity", "#account", "#sync", "#info"]);
const MAX_RAW_CBOR_BASE64_BYTES = 7 * 1024 * 1024;

function asAtFirehoseRawEnvelope(event: unknown): AtFirehoseRawEnvelope | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;

  const e = event as Record<string, unknown>;
  if (typeof e["source"] !== "string" ||
      e["source"].length === 0 || e["source"].length > 2048 ||
      typeof e["rawCborBase64"] !== "string" ||
      e["rawCborBase64"].length === 0 ||
      e["rawCborBase64"].length > MAX_RAW_CBOR_BASE64_BYTES ||
      typeof e["eventType"] !== "string" || !RAW_EVENTS.has(e["eventType"]) ||
      typeof e["receivedAt"] !== "string" ||
      e["receivedAt"].length > 64 ||
      !Number.isSafeInteger(e["seq"])) return null;
  const seq = e["seq"] as number;
  if (seq < 0 && !(e["eventType"] === "#info" && seq === -1)) return null;
  const did = e["did"];
  if (did !== undefined && did !== null &&
      (typeof did !== "string" || did.length > 2048)) return null;
  return event as AtFirehoseRawEnvelope;
}
