import { Kafka, logLevel } from "kafkajs";
import type { Consumer, EachBatchPayload } from "kafkajs";
import { request } from "undici";
import { z } from "zod";
import { DefaultRetryClassifier, withRetry } from "../protocol-bridge/workers/Retry.js";

const mediaAssetSchema = z.object({
  assetId: z.string().min(1),
  ownerId: z.string().min(1),
  canonicalUrl: z.string().url(),
  mimeType: z.string().min(1),
  sourceUrls: z.array(z.string().url()).optional(),
}).passthrough();

const mediaAssetEventSchema = z.object({
  asset: mediaAssetSchema,
  bindings: z.object({
    activitypub: z.object({
      url: z.string().url(),
      mediaType: z.string().min(1),
      deliveryKind: z.enum(["original", "playback", "streaming"]).optional(),
      canonicalUrl: z.string().url().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  signals: z.unknown().optional(),
}).passthrough();

export interface MediaAssetSyncConsumerConfig {
  brokers: string[];
  clientId: string;
  consumerGroupId: string;
  mediaAssetTopic: string;
  activityPodsBaseUrl: string;
  activityPodsBearerToken: string;
  endpointPath?: string;
  requestTimeoutMs?: number;
  retryPolicy?: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: "full";
  };
}

export interface MediaAssetSyncLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: MediaAssetSyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type MediaAssetEvent = z.infer<typeof mediaAssetEventSchema>;

export class MediaAssetSyncConsumer {
  private consumer: Consumer | null = null;
  private running = false;
  private readonly endpointUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly retryPolicy: NonNullable<MediaAssetSyncConsumerConfig["retryPolicy"]>;
  private readonly retryClassifier = new DefaultRetryClassifier();

  constructor(
    private readonly config: MediaAssetSyncConsumerConfig,
    private readonly logger: MediaAssetSyncLogger = NOOP_LOGGER,
  ) {
    this.endpointUrl = buildEndpointUrl(
      config.activityPodsBaseUrl,
      config.endpointPath ?? "/api/internal/media-pipeline/assets",
    );
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.retryPolicy = config.retryPolicy ?? {
      maxAttempts: 4,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
      jitter: "full",
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const kafka = new Kafka({
      clientId: `${this.config.clientId}-media-assets`,
      brokers: this.config.brokers,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 100, retries: 8 },
    });

    this.consumer = kafka.consumer({
      groupId: this.config.consumerGroupId,
      allowAutoTopicCreation: false,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.config.mediaAssetTopic });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        await this.processBatch(payload);
      },
    });

    this.logger.info("MediaAssetSyncConsumer started", {
      topic: this.config.mediaAssetTopic,
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
        // Best-effort shutdown.
      }
      try {
        await this.consumer.disconnect();
      } catch {
        // Best-effort shutdown.
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

      const parsed = this.parseMessage(raw, message.offset);
      if (!parsed) {
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary();
        await heartbeat();
        continue;
      }

      await this.syncEvent(parsed, {
        partition: batch.partition,
        offset: message.offset,
      });

      resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
    }
  }

  private parseMessage(raw: string, offset: string): MediaAssetEvent | null {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      this.logger.warn("media.asset.created.v1 message could not be parsed", { offset });
      return null;
    }

    const parsed = mediaAssetEventSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.logger.warn("media.asset.created.v1 message failed schema validation", {
        offset,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
      return null;
    }

    return parsed.data;
  }

  private async syncEvent(
    event: MediaAssetEvent,
    meta: { partition: number; offset: string },
  ): Promise<void> {
    const requestBody = JSON.stringify({
      asset: event.asset,
      bindings: event.bindings ?? {},
      signals: event.signals ?? null,
      receivedAt: new Date().toISOString(),
      sourceTopic: this.config.mediaAssetTopic,
      sourcePartition: meta.partition,
      sourceOffset: meta.offset,
    });

    try {
      await withRetry(
        async () => {
          const response = await request(this.endpointUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.config.activityPodsBearerToken}`,
            },
            body: requestBody,
            bodyTimeout: this.requestTimeoutMs,
            headersTimeout: this.requestTimeoutMs,
          });

          const responseText = await response.body.text();
          if (response.statusCode === 404) {
            this.logger.warn("ActivityPods media sync endpoint is not available yet", {
              endpointUrl: this.endpointUrl,
            });
            return;
          }

          if ([400, 403, 409, 415, 422].includes(response.statusCode)) {
            this.logger.warn("ActivityPods rejected media asset sync payload", {
              assetId: event.asset.assetId,
              statusCode: response.statusCode,
              response: truncate(responseText, 256),
            });
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(
              `ActivityPods media asset sync failed with HTTP ${response.statusCode}: ${truncate(responseText, 256)}`,
            ) as Error & { statusCode?: number; retryable?: boolean };
            error.statusCode = response.statusCode;
            error.retryable = response.statusCode === 429 || response.statusCode >= 500;
            throw error;
          }
        },
        this.retryPolicy,
        this.retryClassifier,
      );

      this.logger.info("Media asset synced to ActivityPods", {
        assetId: event.asset.assetId,
        ownerId: event.asset.ownerId,
      });
    } catch (error) {
      this.logger.error("Media asset sync failed after retries", {
        assetId: event.asset.assetId,
        ownerId: event.asset.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  const parsed = new URL(baseUrl);
  return new URL(endpointPath, parsed).toString();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
