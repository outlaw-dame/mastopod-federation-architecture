import { randomUUID } from "node:crypto";
import { CompressionTypes, Kafka, Producer, logLevel, type IHeaders } from "kafkajs";
import type {
  CoreIdentityEvent,
  EventMetadata,
  EventPublisher,
} from "./CoreIdentityEvents.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";

export interface RedpandaEventPublisherConfig {
  brokers: string[];
  clientId: string;
  source?: string;
  compression?: "none" | "gzip" | "snappy" | "lz4" | "zstd";
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxEventBytes?: number;
  maxBatchSize?: number;
}

export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(payload: {
    topic: string;
    messages: Array<{
      key?: string;
      value: string;
      headers?: IHeaders;
      timestamp?: string;
    }>;
    compression?: CompressionTypes;
  }): Promise<unknown>;
}

export class RedpandaEventPublisher implements EventPublisher {
  private readonly producer: KafkaProducerLike;
  private readonly compression?: CompressionTypes;
  private readonly source: string;
  private readonly maxEventBytes: number;
  private readonly maxBatchSize: number;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  public constructor(
    config: RedpandaEventPublisherConfig,
    producer?: KafkaProducerLike,
  ) {
    this.source = config.source ?? "fedify-sidecar";
    this.maxEventBytes = config.maxEventBytes ?? 512_000;
    this.maxBatchSize = config.maxBatchSize ?? 64;
    this.compression = resolveCompression(config.compression ?? "zstd");
    this.producer = producer ?? createProducer(config);
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.producer.connect()
      .then(() => {
        this.connected = true;
        logInfo("RedPanda event publisher connected");
      })
      .finally(() => {
        this.connectPromise = null;
      });

    return this.connectPromise;
  }

  public async disconnect(): Promise<void> {
    if (!this.connected && !this.connectPromise) {
      return;
    }
    await this.connectPromise;
    await this.producer.disconnect();
    this.connected = false;
    logInfo("RedPanda event publisher disconnected");
  }

  public async publish<T extends CoreIdentityEvent>(
    topic: string,
    event: T,
    metadata?: Partial<EventMetadata>,
  ): Promise<void> {
    await this.publishBatch([{ topic, event, metadata }]);
  }

  public async publishBatch(
    events: Array<{
      topic: string;
      event: CoreIdentityEvent;
      metadata?: Partial<EventMetadata>;
    }>,
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    if (events.length > this.maxBatchSize) {
      throw Object.assign(
        new Error(`Event batch exceeds maximum size ${this.maxBatchSize}.`),
        { code: "EVENT_BATCH_TOO_LARGE", transient: false, status: 400 },
      );
    }

    await this.connect();

    const grouped = new Map<string, Array<{
      key?: string;
      value: string;
      headers: IHeaders;
      timestamp: string;
    }>>();

    for (const { topic, event, metadata } of events) {
      if (!topic?.trim()) {
        throw Object.assign(
          new Error("Event topic must be a non-empty string."),
          { code: "EVENT_TOPIC_INVALID", transient: false, status: 400 },
        );
      }

      const eventRecord = event as unknown as Record<string, unknown>;
      const enrichedMetadata = buildMetadata(topic, eventRecord, metadata, this.source);
      const payload = sanitizeJsonObject(event, {
        maxBytes: this.maxEventBytes,
      });
      const serialized = JSON.stringify(payload);
      const message = {
        key: enrichedMetadata.partitionKey,
        value: serialized,
        headers: buildHeaders(enrichedMetadata, eventRecord),
        timestamp: String(Date.parse(enrichedMetadata.emittedAt) || Date.now()),
      };
      const messages = grouped.get(topic) ?? [];
      messages.push(message);
      grouped.set(topic, messages);
    }

    for (const [topic, messages] of grouped.entries()) {
      await this.producer.send({
        topic,
        messages,
        ...(typeof this.compression === "number" ? { compression: this.compression } : {}),
      });
    }
  }
}

function createProducer(config: RedpandaEventPublisherConfig): Producer {
  const kafka = new Kafka({
    clientId: config.clientId,
    brokers: config.brokers,
    connectionTimeout: config.connectionTimeoutMs ?? 10_000,
    requestTimeout: config.requestTimeoutMs ?? 30_000,
    logLevel: logLevel.WARN,
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  });

  return kafka.producer({
    allowAutoTopicCreation: true,
    transactionTimeout: 30_000,
  });
}

function resolveCompression(
  value: RedpandaEventPublisherConfig["compression"],
): CompressionTypes | undefined {
  switch (value) {
    case "gzip":
      return CompressionTypes.GZIP;
    case "snappy":
      return CompressionTypes.Snappy;
    case "lz4":
      return CompressionTypes.LZ4;
    case "zstd":
      return CompressionTypes.ZSTD;
    case "none":
    default:
      return undefined;
  }
}

function buildMetadata(
  topic: string,
  event: Record<string, unknown>,
  metadata: Partial<EventMetadata> | undefined,
  source: string,
): EventMetadata {
  const emittedAt = metadata?.emittedAt ?? new Date().toISOString();
  return {
    eventId: metadata?.eventId ?? randomUUID(),
    topic,
    partitionKey: metadata?.partitionKey ?? derivePartitionKey(event, topic),
    emittedAt,
    source: metadata?.source ?? source,
    traceId: metadata?.traceId,
    spanId: metadata?.spanId,
    correlationId: metadata?.correlationId,
  };
}

function derivePartitionKey(event: Record<string, unknown>, topic: string): string {
  const candidates = [
    event["canonicalAccountId"],
    event["did"],
    event["repoDid"],
    event["actor"],
    event["activityId"],
    event["id"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return topic;
}

function buildHeaders(
  metadata: EventMetadata,
  event: Record<string, unknown>,
): IHeaders {
  const eventType =
    typeof event["type"] === "string"
      ? event["type"]
      : typeof event["eventType"] === "string"
        ? event["eventType"]
        : undefined;

  const headers: IHeaders = {
    "event-id": metadata.eventId,
    "event-topic": metadata.topic,
    "event-source": metadata.source,
    "event-emitted-at": metadata.emittedAt,
    "partition-key": metadata.partitionKey,
  };

  if (eventType) {
    headers["event-type"] = eventType;
  }
  if (metadata.traceId) {
    headers["trace-id"] = metadata.traceId;
  }
  if (metadata.spanId) {
    headers["span-id"] = metadata.spanId;
  }
  if (metadata.correlationId) {
    headers["correlation-id"] = metadata.correlationId;
  }
  return headers;
}

function logInfo(message: string): void {
  if (process.env["NODE_ENV"] === "test") {
    return;
  }
  console.info(`[RedpandaEventPublisher] ${message}`);
}
