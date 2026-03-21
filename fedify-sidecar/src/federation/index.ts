/**
 * Fedify Federation Setup
 * 
 * Configures the Fedify federation instance with:
 * - RedPanda as the message queue backend
 * - Actor dispatcher for fetching from ActivityPods
 * - Inbox listener for handling incoming activities
 * - Outbox dispatcher for sending activities
 */

import {
  createFederation,
  Person,
  Organization,
  Service,
  Application,
  Group,
  MemoryKvStore,
  InProcessMessageQueue,
  type Federation,
  type Actor,
  type Context,
  type Activity,
} from "@fedify/fedify";
import { RedPandaMessageQueue, createRedPandaMessageQueue } from "../queue/redpanda-message-queue.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { SigningService } from "../services/signing.js";
import { ActivityPodsClient } from "../services/activitypods-client.js";

// Actor types supported by ActivityPods
type ActorType = typeof Person | typeof Organization | typeof Service | typeof Application | typeof Group;

const ACTOR_TYPE_MAP: Record<string, ActorType> = {
  "Person": Person,
  "Organization": Organization,
  "Service": Service,
  "Application": Application,
  "Group": Group,
};

export interface FederationContext {
  federation: Federation<void>;
  messageQueue: RedPandaMessageQueue;
  signingService: SigningService;
  activityPodsClient: ActivityPodsClient;
}

/**
 * Create and configure the Fedify federation instance
 */
export async function createFederationContext(): Promise<FederationContext> {
  logger.info("Creating Fedify federation context...");

  // Initialize services
  const signingService = new SigningService(config.activitypods.signingApiUrl);
  const activityPodsClient = new ActivityPodsClient(config.activitypods.url);

  // Create RedPanda message queue
  const messageQueue = createRedPandaMessageQueue(
    config.redpanda.brokers,
    config.redpanda.clientId
  );

  // Initialize the message queue
  await messageQueue.initialize();

  // Create the federation instance
  const federation = createFederation<void>({
    kv: new MemoryKvStore(), // For caching actor data, etc.
    queue: messageQueue,
    
    // Retry policy for failed deliveries
    outboxRetryPolicy: {
      maxAttempts: 8,
      initialDelay: 1000,
      maxDelay: 3600000, // 1 hour max
      
      async getDelay(attempt: number): Promise<number> {
        // Exponential backoff: (attempt^4) + 15 + random
        return Math.pow(attempt, 4) * 1000 + 15000 + Math.random() * 30000 * (attempt + 1);
      },
    },
  });

  // Configure actor dispatcher
  setupActorDispatcher(federation, activityPodsClient);

  // Configure inbox listener
  setupInboxListener(federation, activityPodsClient);

  // Configure outbox dispatcher
  setupOutboxDispatcher(federation, signingService);

  // Configure NodeInfo
  setupNodeInfo(federation);

  // Configure WebFinger
  setupWebFinger(federation, activityPodsClient);

  logger.info("Fedify federation context created successfully");

  return {
    federation,
    messageQueue,
    signingService,
    activityPodsClient,
  };
}

/**
 * Setup actor dispatcher - fetches actor data from ActivityPods
 */
function setupActorDispatcher(
  federation: Federation<void>,
  activityPodsClient: ActivityPodsClient
): void {
  federation.setActorDispatcher("/users/{handle}", async (ctx, handle) => {
    logger.debug("Dispatching actor", { handle });

    try {
      const actorData = await activityPodsClient.getActor(handle);

      if (!actorData) {
        logger.warn("Actor not found", { handle });
        return null;
      }

      const ActorClass = ACTOR_TYPE_MAP[actorData.type] ?? Person;

      return new ActorClass({
        id: ctx.getActorUri(handle),
        preferredUsername: handle,
        name: actorData.name,
        summary: actorData.summary,
        inbox: ctx.getInboxUri(handle),
        outbox: ctx.getOutboxUri(handle),
        followers: ctx.getFollowersUri(handle),
        following: ctx.getFollowingUri(handle),
        publicKey: actorData.publicKey ? {
          id: new URL(`${actorData.id}#main-key`),
          owner: new URL(actorData.id),
          publicKeyPem: actorData.publicKey.publicKeyPem,
        } : undefined,
        url: actorData.url ? new URL(actorData.url) : undefined,
        icon: actorData.icon,
        image: actorData.image,
      });
    } catch (error) {
      logger.error("Failed to dispatch actor", { handle, error });
      return null;
    }
  });

  // Key pair dispatcher for signing
  federation.setKeyPairDispatcher("/users/{handle}", async (ctx, handle) => {
    logger.debug("Dispatching key pair", { handle });

    try {
      const keyPair = await activityPodsClient.getActorKeyPair(handle);
      
      if (!keyPair) {
        logger.warn("Key pair not found", { handle });
        return null;
      }

      return {
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
      };
    } catch (error) {
      logger.error("Failed to dispatch key pair", { handle, error });
      return null;
    }
  });
}

/**
 * Setup inbox listener - handles incoming activities from remote servers
 */
function setupInboxListener(
  federation: Federation<void>,
  activityPodsClient: ActivityPodsClient
): void {
  // Shared inbox for all users
  federation.setInboxListeners("/inbox", "/users/{handle}/inbox");

  // Handle all activity types
  federation.on("*", async (ctx, activity) => {
    logger.info("Received activity", {
      type: activity.constructor.name,
      id: activity.id?.href,
      actor: activity.actorId?.href,
    });

    try {
      // Forward the activity to ActivityPods
      await activityPodsClient.forwardInboxActivity(activity);

      logger.debug("Activity forwarded to ActivityPods", {
        id: activity.id?.href,
      });
    } catch (error) {
      logger.error("Failed to forward activity", {
        id: activity.id?.href,
        error,
      });
      throw error; // Re-throw to trigger retry
    }
  });
}

/**
 * Setup outbox dispatcher - handles outgoing activities
 */
function setupOutboxDispatcher(
  federation: Federation<void>,
  signingService: SigningService
): void {
  federation.setOutboxDispatcher("/users/{handle}/outbox", async (ctx, handle, cursor) => {
    logger.debug("Dispatching outbox", { handle, cursor });

    // The outbox is managed by ActivityPods
    // We just provide a read-only view for federation
    return {
      items: [],
      nextCursor: null,
    };
  });
}

/**
 * Setup NodeInfo for server discovery
 */
function setupNodeInfo(federation: Federation<void>): void {
  federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (ctx) => {
    return {
      software: {
        name: "activitypods",
        version: config.version,
        repository: new URL("https://github.com/activitypods/activitypods"),
      },
      protocols: ["activitypub"],
      usage: {
        users: {
          total: 0, // TODO: Fetch from ActivityPods
          activeMonth: 0,
          activeHalfyear: 0,
        },
        localPosts: 0,
      },
      openRegistrations: true,
    };
  });
}

/**
 * Setup WebFinger for actor discovery
 */
function setupWebFinger(
  federation: Federation<void>,
  activityPodsClient: ActivityPodsClient
): void {
  federation.setActorDispatcher("/.well-known/webfinger", async (ctx, resource) => {
    // WebFinger is handled by the actor dispatcher
    // This is just for completeness
    return null;
  });
}

/**
 * Start the federation (begin processing queues)
 */
export async function startFederation(context: FederationContext): Promise<void> {
  logger.info("Starting Fedify federation...");

  // Start listening for messages
  await context.messageQueue.listen(async (message) => {
    // Messages are processed by Fedify's internal handlers
    logger.debug("Processing queued message", { type: (message as any).type });
  });

  logger.info("Fedify federation started");
}

/**
 * Stop the federation gracefully
 */
export async function stopFederation(context: FederationContext): Promise<void> {
  logger.info("Stopping Fedify federation...");

  await context.messageQueue.close();

  logger.info("Fedify federation stopped");
}
