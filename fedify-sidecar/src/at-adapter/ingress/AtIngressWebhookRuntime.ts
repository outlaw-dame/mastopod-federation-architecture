import { Kafka, logLevel, type Consumer } from "kafkajs";
import { createRequire } from "node:module";
import SnappyCodec from "kafkajs-snappy";
import { AtIngressWebhookForwarder } from "./AtIngressWebhookForwarder.js";
import type { AtIngressEvent } from "./AtIngressEvents.js";

// Redpanda topics may contain snappy-compressed record batches. KafkaJS does
// not ship a built-in snappy decoder, so register one explicitly.
const require = createRequire(import.meta.url);
const { CompressionCodecs, CompressionTypes } = require("kafkajs") as {
  CompressionCodecs?: Record<number, unknown>;
  CompressionTypes?: { Snappy: number };
};
if (CompressionCodecs && CompressionTypes) {
  CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec;
}

export interface AtIngressWebhookRuntimeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AtIngressWebhookRuntimeOptions {
  brokers: string[];
  clientId: string;
  consumerGroupId: string;
  ingressTopic: string;
  webhookUrl: string;
  webhookSecret: string;
  endpointId?: string;
  logger?: AtIngressWebhookRuntimeLogger;
}

const NOOP_LOGGER: AtIngressWebhookRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class AtIngressWebhookRuntime {
  private readonly logger: AtIngressWebhookRuntimeLogger;
  private readonly consumer: Consumer;
  private readonly forwarder: AtIngressWebhookForwarder;
  private readonly ingressTopic: string;
  private running = false;

  public constructor(private readonly options: AtIngressWebhookRuntimeOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.ingressTopic = options.ingressTopic;
    this.forwarder = new AtIngressWebhookForwarder();

    const endpointId = options.endpointId ?? "memory-api";
    this.forwarder.registerEndpoint({
      id: endpointId,
      url: options.webhookUrl,
      secret: options.webhookSecret,
    });

    const kafka = new Kafka({
      clientId: `${options.clientId}-at-ingress-webhook`,
      brokers: options.brokers,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    this.consumer = kafka.consumer({
      groupId: options.consumerGroupId,
      allowAutoTopicCreation: false,
    });
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.ingressTopic, fromBeginning: false });

    await this.consumer.run({
      autoCommit: true,
      eachBatchAutoResolve: false,
      eachBatch: async ({
        batch,
        resolveOffset,
        heartbeat,
        commitOffsetsIfNecessary,
        isRunning,
        isStale,
      }) => {
        const pendingOffsets: string[] = [];
        const events: AtIngressEvent[] = [];

        for (const message of batch.messages) {
          if (!isRunning() || isStale()) {
            return;
          }

          const raw = message.value ? Buffer.from(message.value).toString("utf8") : "";
          if (!raw) {
            resolveOffset(message.offset);
            await commitOffsetsIfNecessary();
            await heartbeat();
            continue;
          }

          try {
            const parsed = JSON.parse(raw) as unknown;
            if (isAtIngressEvent(parsed)) {
              events.push(parsed);
              pendingOffsets.push(message.offset);
            } else {
              this.logger.warn("Dropping malformed at.ingress event before webhook forwarding", {
                topic: batch.topic,
                partition: batch.partition,
                offset: message.offset,
              });
              resolveOffset(message.offset);
              await commitOffsetsIfNecessary();
              await heartbeat();
            }
          } catch (error) {
            this.logger.warn("Dropping non-JSON at.ingress event before webhook forwarding", {
              topic: batch.topic,
              partition: batch.partition,
              offset: message.offset,
              error: error instanceof Error ? error.message : String(error),
            });
            resolveOffset(message.offset);
            await commitOffsetsIfNecessary();
            await heartbeat();
          }
        }

        if (events.length > 0) {
          const results = await this.forwarder.forwardBatch(events);
          const failed = results.filter(result => !result.success);

          if (failed.length > 0) {
            const first = failed[0];
            this.logger.error("AT ingress webhook forwarding failed", {
              topic: batch.topic,
              partition: batch.partition,
              events: events.length,
              failures: failed.length,
              endpointId: first?.endpointId,
              error: first?.error,
              statusCode: first?.statusCode,
            });
            throw new Error(`at ingress webhook forwarding failed for ${failed.length} batch(es)`);
          }

          for (const offset of pendingOffsets) {
            resolveOffset(offset);
          }
          await commitOffsetsIfNecessary();
          await heartbeat();

          this.logger.info("Forwarded verified AT ingress batch to webhook", {
            topic: batch.topic,
            partition: batch.partition,
            events: events.length,
          });
        }
      },
    });

    this.logger.info("AT ingress webhook runtime started", {
      topic: this.ingressTopic,
      consumerGroupId: this.options.consumerGroupId,
      webhookUrl: this.options.webhookUrl,
    });
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    try {
      await this.consumer.stop();
    } finally {
      await this.consumer.disconnect();
    }

    this.logger.info("AT ingress webhook runtime stopped", {
      topic: this.ingressTopic,
    });
  }
}

function isAtIngressEvent(value: unknown): value is AtIngressEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate["seq"] !== "number") return false;
  if (typeof candidate["did"] !== "string") return false;
  if (typeof candidate["source"] !== "string") return false;
  if (typeof candidate["verifiedAt"] !== "string") return false;

  const eventType = candidate["eventType"];
  return eventType === "#commit" || eventType === "#identity" || eventType === "#account";
}
