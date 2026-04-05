import { Kafka, logLevel, type Consumer, type EachBatchPayload } from "kafkajs";
import type { AtCommitV1 } from "../../at-adapter/events/AtRepoEvents.js";
import type { ActivityPubBridgeIngressEvent, ActivityPubBridgeMetadata } from "../events/ActivityPubBridgeEvents.js";
import type { TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { DefaultRetryClassifier } from "../workers/Retry.js";
import type { ApToAtProjectionWorker } from "../workers/ApToAtProjectionWorker.js";
import type { AtToApProjectionWorker } from "../workers/AtToApProjectionWorker.js";
import type { ActivityPubBridgeIngressPort } from "./ActivityPubBridgeIngressClient.js";

export interface ProtocolBridgeRuntimeConfig {
  brokers: string[];
  clientId: string;
  consumerGroupId: string;
  apSourceTopic: string;
  atCommitTopic: string;
  atVerifiedIngressTopic?: string | null;
  apIngressTopic: string;
  enableApToAt: boolean;
  enableAtToAp: boolean;
}

export interface ProtocolBridgeLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ProtocolBridgeConsumerLike {
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

export interface ProtocolBridgeRuntimeOptions {
  config: ProtocolBridgeRuntimeConfig;
  translationContext: TranslationContext;
  apToAtWorker?: ApToAtProjectionWorker;
  atToApWorker?: AtToApProjectionWorker;
  apIngressForwarder?: ActivityPubBridgeIngressPort;
  logger?: ProtocolBridgeLogger;
  consumerFactory?: (groupId: string) => ProtocolBridgeConsumerLike;
}

interface ApSourceWrapper {
  activity: Record<string, unknown>;
  bridge?: ActivityPubBridgeMetadata;
}

interface AtVerifiedIngressCommitEvent {
  did: string;
  commit: {
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    cid?: string | null;
    canonicalRefId?: string;
    record?: Record<string, unknown> | null;
  };
}

const NOOP_LOGGER: ProtocolBridgeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class ProtocolBridgeRuntime {
  private readonly logger: ProtocolBridgeLogger;
  private readonly retryClassifier = new DefaultRetryClassifier();
  private readonly consumers: ProtocolBridgeConsumerLike[] = [];
  private started = false;
  private readonly consumerFactory: (groupId: string) => ProtocolBridgeConsumerLike;

  public constructor(private readonly options: ProtocolBridgeRuntimeOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.consumerFactory = options.consumerFactory ?? buildKafkaConsumerFactory(options.config);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.options.config.enableApToAt && this.options.apToAtWorker) {
      await this.startConsumer(
        `${this.options.config.consumerGroupId}-ap-to-at`,
        this.options.config.apSourceTopic,
        async (value) => {
          await this.handleApSourceEvent(value);
        },
      );
    }

    if (this.options.config.enableAtToAp && this.options.atToApWorker) {
      await this.startConsumer(
        `${this.options.config.consumerGroupId}-at-to-ap`,
        this.options.config.atCommitTopic,
        async (value) => {
          await this.handleAtCommitEvent(value);
        },
      );

      const verifiedIngressTopic = this.options.config.atVerifiedIngressTopic?.trim();
      if (
        verifiedIngressTopic &&
        verifiedIngressTopic !== this.options.config.atCommitTopic
      ) {
        await this.startConsumer(
          `${this.options.config.consumerGroupId}-at-ingress-to-ap`,
          verifiedIngressTopic,
          async (value) => {
            await this.handleAtVerifiedIngressEvent(value);
          },
        );
      }
    }

    if (this.options.config.enableAtToAp && this.options.apIngressForwarder) {
      await this.startConsumer(
        `${this.options.config.consumerGroupId}-ap-ingress`,
        this.options.config.apIngressTopic,
        async (value) => {
          await this.handleApIngressEvent(value);
        },
      );
    }

    this.started = true;
    this.logger.info("Protocol bridge runtime started", {
      apToAt: this.options.config.enableApToAt,
      atToAp: this.options.config.enableAtToAp,
      apSourceTopic: this.options.config.apSourceTopic,
      atCommitTopic: this.options.config.atCommitTopic,
      atVerifiedIngressTopic: this.options.config.atVerifiedIngressTopic ?? null,
      apIngressTopic: this.options.config.apIngressTopic,
    });
  }

  public async stop(): Promise<void> {
    const consumers = [...this.consumers].reverse();
    this.consumers.length = 0;

    for (const consumer of consumers) {
      try {
        await consumer.stop();
      } catch {
        // Best-effort shutdown.
      }
      try {
        await consumer.disconnect();
      } catch {
        // Best-effort shutdown.
      }
    }

    this.started = false;
  }

  public async handleApSourceEvent(event: unknown): Promise<void> {
    if (!this.options.apToAtWorker) {
      return;
    }

    const parsed = unwrapApSourceEvent(event);
    if (!parsed) {
      return;
    }
    if (
      parsed.bridge?.provenance.originProtocol === "atproto" &&
      parsed.bridge.provenance.projectionMode === "mirrored"
    ) {
      return;
    }

    await this.options.apToAtWorker.process(parsed.activity, this.options.translationContext);
  }

  public async handleAtCommitEvent(event: unknown): Promise<void> {
    if (!this.options.atToApWorker) {
      return;
    }

    const commit = asAtCommitEvent(event);
    if (!commit) {
      return;
    }

    for (const op of commit.ops) {
      await this.options.atToApWorker.process(
        {
          repoDid: commit.did,
          uri: op.uri ?? `at://${commit.did}/${op.collection}/${op.rkey}`,
          cid: op.cid ?? undefined,
          rkey: op.rkey,
          collection: op.collection,
          canonicalRefId: op.canonicalRefId,
          subjectDid: op.subjectDid ?? undefined,
          subjectUri: op.subjectUri ?? undefined,
          subjectCid: op.subjectCid ?? undefined,
          operation: op.action,
          bridge: op.bridge?.provenance,
          ...(op.record && typeof op.record === "object" ? { record: op.record } : {}),
        },
        this.options.translationContext,
      );
    }
  }

  public async handleAtVerifiedIngressEvent(event: unknown): Promise<void> {
    if (!this.options.atToApWorker) {
      return;
    }

    const ingress = asAtVerifiedIngressEvent(event);
    if (!ingress?.commit) {
      return;
    }

    await this.options.atToApWorker.process(
      {
        repoDid: ingress.did,
        uri: `at://${ingress.did}/${ingress.commit.collection}/${ingress.commit.rkey}`,
        cid: ingress.commit.cid ?? undefined,
        rkey: ingress.commit.rkey,
        collection: ingress.commit.collection,
        canonicalRefId: ingress.commit.canonicalRefId,
        operation: ingress.commit.operation,
        ...(ingress.commit.record && typeof ingress.commit.record === "object"
          ? { record: ingress.commit.record }
          : {}),
      },
      this.options.translationContext,
    );
  }

  public async handleApIngressEvent(event: unknown): Promise<void> {
    if (!this.options.apIngressForwarder) {
      return;
    }

    const parsed = asActivityPubBridgeIngressEvent(event);
    if (!parsed) {
      return;
    }

    await this.options.apIngressForwarder.deliver(parsed);
  }

  private async startConsumer(
    groupId: string,
    topic: string,
    handler: (event: unknown) => Promise<void>,
  ): Promise<void> {
    const consumer = this.consumerFactory(groupId);
    await consumer.connect();
    await consumer.subscribe({ topic });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async (payload) => {
        await this.processBatch(payload, handler, topic);
      },
    });
    this.consumers.push(consumer);
  }

  private async processBatch(
    payload: EachBatchPayload,
    handler: (event: unknown) => Promise<void>,
    topic: string,
  ): Promise<void> {
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
        await handler(JSON.parse(value));
      } catch (error) {
        if (this.retryClassifier.isTransient(error)) {
          this.logger.warn("Protocol bridge consumer hit a transient error", {
            topic,
            offset: message.offset,
            error: asErrorMessage(error),
          });
          throw error;
        }

        this.logger.error("Protocol bridge consumer dropped a non-retryable event", {
          topic,
          offset: message.offset,
          error: asErrorMessage(error),
        });
      }

      resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
    }
  }
}

function buildKafkaConsumerFactory(
  config: ProtocolBridgeRuntimeConfig,
): (groupId: string) => Consumer {
  const kafka = new Kafka({
    clientId: `${config.clientId}-protocol-bridge`,
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

function unwrapApSourceEvent(event: unknown): ApSourceWrapper | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  const activity = candidate["activity"];
  if (activity && typeof activity === "object" && !Array.isArray(activity)) {
    return {
      activity: activity as Record<string, unknown>,
      bridge: asActivityPubBridgeMetadata(candidate["bridge"]),
    };
  }

  if (typeof candidate["type"] === "string" && candidate["actor"]) {
    return {
      activity: candidate as Record<string, unknown>,
    };
  }

  return null;
}

function asAtCommitEvent(event: unknown): AtCommitV1 | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  if (typeof candidate["did"] !== "string" || !Array.isArray(candidate["ops"])) {
    return null;
  }

  return candidate as unknown as AtCommitV1;
}

function asAtVerifiedIngressEvent(event: unknown): AtVerifiedIngressCommitEvent | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  const commit = candidate["commit"];
  if (
    typeof candidate["did"] !== "string" ||
    candidate["eventType"] !== "#commit" ||
    !commit ||
    typeof commit !== "object" ||
    Array.isArray(commit)
  ) {
    return null;
  }

  const commitRecord = commit as Record<string, unknown>;
  const operation = commitRecord["operation"];
  const collection = commitRecord["collection"];
  const rkey = commitRecord["rkey"];
  if (
    operation !== "create" &&
    operation !== "update" &&
    operation !== "delete"
  ) {
    return null;
  }
  if (typeof collection !== "string" || collection.length === 0) {
    return null;
  }
  if (typeof rkey !== "string" || rkey.length === 0) {
    return null;
  }

  const cid = typeof commitRecord["cid"] === "string"
    ? commitRecord["cid"]
    : commitRecord["cid"] === null
      ? null
      : undefined;
  const canonicalRefId = typeof commitRecord["canonicalRefId"] === "string"
    ? commitRecord["canonicalRefId"]
    : undefined;
  const record = commitRecord["record"] && typeof commitRecord["record"] === "object" && !Array.isArray(commitRecord["record"])
    ? commitRecord["record"] as Record<string, unknown>
    : commitRecord["record"] === null
      ? null
      : undefined;

  return {
    did: candidate["did"],
    commit: {
      operation,
      collection,
      rkey,
      cid,
      canonicalRefId,
      record,
    },
  };
}

function asActivityPubBridgeIngressEvent(event: unknown): ActivityPubBridgeIngressEvent | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  if (
    candidate["version"] !== 1 ||
    typeof candidate["activityId"] !== "string" ||
    typeof candidate["actor"] !== "string" ||
    !candidate["activity"] ||
    typeof candidate["activity"] !== "object" ||
    Array.isArray(candidate["activity"]) ||
    !candidate["bridge"] ||
    typeof candidate["receivedAt"] !== "string"
  ) {
    return null;
  }

  return candidate as unknown as ActivityPubBridgeIngressEvent;
}

function asActivityPubBridgeMetadata(value: unknown): ActivityPubBridgeMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as ActivityPubBridgeMetadata;
  if (
    typeof candidate.canonicalIntentId !== "string" ||
    (candidate.sourceProtocol !== "activitypub" && candidate.sourceProtocol !== "atproto") ||
    !candidate.provenance ||
    typeof candidate.provenance.originEventId !== "string"
  ) {
    return undefined;
  }

  return candidate;
}

function readMessageValue(value: Buffer | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const text = value.toString("utf8").trim();
  return text.length > 0 ? text : null;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
