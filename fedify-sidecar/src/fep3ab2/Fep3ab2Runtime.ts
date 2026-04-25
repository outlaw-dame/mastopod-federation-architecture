import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { DurableStreamSubscriptionService } from "../feed/DurableStreamSubscriptionService.js";
import { Fep3ab2ActivityPodsClient } from "./Fep3ab2ActivityPodsClient.js";
import { Fep3ab2Dispatcher } from "./Fep3ab2Dispatcher.js";
import { Fep3ab2EventHub } from "./Fep3ab2EventHub.js";
import { registerFep3ab2Routes } from "./Fep3ab2FastifyRoutes.js";
import { Fep3ab2PrivateRealtimeSubscriber } from "./Fep3ab2PrivateRealtimeSubscriber.js";
import { Fep3ab2ReplayStore } from "./Fep3ab2ReplayStore.js";
import { Fep3ab2SessionMutationSubscriber } from "./Fep3ab2SessionMutationSubscriber.js";
import { Fep3ab2SessionStore } from "./Fep3ab2SessionStore.js";
import { Fep3ab2TopicRouter } from "./Fep3ab2TopicRouter.js";
import { logger } from "../utils/logger.js";

export interface Fep3ab2RuntimeOptions {
  app: FastifyInstance;
  streamSubscriptionService: DurableStreamSubscriptionService;
  redisUrl: string;
  activityPodsBaseUrl: string;
  activityPodsToken: string;
  ticketSecret: string;
  publicBaseUrl?: string;
  allowedOrigins?: string[];
  ticketTtlSec?: number;
  heartbeatIntervalMs?: number;
  cookieName?: string;
  cookiePath?: string;
  cookieSameSite?: "Lax" | "Strict" | "None";
  cookieSecure?: boolean;
  cookieDomain?: string;
  prefix?: string;
  privateRealtimeChannel?: string;
  replayTtlSec?: number;
  replayMaxEvents?: number;
  replayMaxIndexSize?: number;
  maxPendingReplayPublishes?: number;
  maxStreamBufferBytes?: number;
}

export class Fep3ab2Runtime {
  private readonly redis: Redis;
  private readonly authorityClient: Fep3ab2ActivityPodsClient;
  private readonly sessionStore: Fep3ab2SessionStore;
  private readonly eventHub: Fep3ab2EventHub;
  private readonly replayStore: Fep3ab2ReplayStore;
  private readonly dispatcher: Fep3ab2Dispatcher;
  private readonly topicRouter: Fep3ab2TopicRouter;
  private readonly mutationSubscriber: Fep3ab2SessionMutationSubscriber;
  private readonly privateRealtimeSubscriber: Fep3ab2PrivateRealtimeSubscriber;
  private readonly unregisterObserver: () => void;

  public constructor(private readonly options: Fep3ab2RuntimeOptions) {
    this.redis = new Redis(options.redisUrl);
    this.redis.on("error", (error: Error) => {
      logger.error("FEP-3ab2 Redis client error", { error: error.message });
    });

    this.authorityClient = new Fep3ab2ActivityPodsClient({
      activityPodsBaseUrl: options.activityPodsBaseUrl,
      bearerToken: options.activityPodsToken,
    });
    this.sessionStore = new Fep3ab2SessionStore(this.redis, {
      prefix: options.prefix,
      ticketSecret: options.ticketSecret,
      ticketTtlSec: options.ticketTtlSec,
    });
    this.eventHub = new Fep3ab2EventHub(options.heartbeatIntervalMs);
    this.replayStore = new Fep3ab2ReplayStore(this.redis, {
      prefix: options.prefix,
      ttlSec: options.replayTtlSec,
      maxReplayEvents: options.replayMaxEvents,
      maxIndexSize: options.replayMaxIndexSize,
    });
    this.dispatcher = new Fep3ab2Dispatcher(this.eventHub, this.replayStore, {
      maxPendingReplayPublishes: options.maxPendingReplayPublishes,
    });
    this.topicRouter = new Fep3ab2TopicRouter(this.dispatcher);
    this.mutationSubscriber = new Fep3ab2SessionMutationSubscriber(
      this.redis,
      this.sessionStore.mutationChannel,
      (event) => {
        if (event.type === "subscriptions_updated") {
          this.eventHub.updateSessionTopics(event.sessionId, event.topics);
        } else if (event.type === "revoked") {
          this.eventHub.closeSession(event.sessionId, "revoked");
        }
      },
    );
    this.privateRealtimeSubscriber = new Fep3ab2PrivateRealtimeSubscriber(
      this.redis,
      options.privateRealtimeChannel ?? `${options.prefix ?? "fep3ab2"}:private-events`,
      (message) => {
        this.topicRouter.handlePrivateRealtimeMessage(message);
      },
    );
    this.unregisterObserver = options.streamSubscriptionService.registerEnvelopeObserver((envelope) => {
      this.topicRouter.handleStreamEnvelope(envelope);
    });

    registerFep3ab2Routes(options.app, {
      authorityClient: this.authorityClient,
      sessionStore: this.sessionStore,
      eventHub: this.eventHub,
      replayStore: this.replayStore,
      publicBaseUrl: options.publicBaseUrl,
      cookieName: options.cookieName,
      cookiePath: options.cookiePath,
      cookieSameSite: options.cookieSameSite,
      cookieSecure: options.cookieSecure,
      cookieDomain: options.cookieDomain,
      allowedOrigins: options.allowedOrigins,
      maxStreamBufferBytes: options.maxStreamBufferBytes,
    });
  }

  public async start(): Promise<void> {
    this.eventHub.start();
    await this.mutationSubscriber.start();
    await this.privateRealtimeSubscriber.start();
    logger.info("FEP-3ab2 runtime started");
  }

  public async shutdown(): Promise<void> {
    this.unregisterObserver();
    this.eventHub.shutdown();
    await Promise.allSettled([
      this.mutationSubscriber.close(),
      this.privateRealtimeSubscriber.close(),
    ]);
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
