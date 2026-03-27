/**
 * Fedify Sidecar for ActivityPods - v5
 * 
 * Main entry point that initializes and starts all services:
 * - Redis Streams for work queues (inbound/outbound)
 * - RedPanda for event logs (Stream1, Stream2, Firehose)
 * - OpenSearch for activity storage and querying
 * - HTTP server for receiving inbound activities
 * - Workers for processing inbound/outbound activities
 * 
 * Key Architecture:
 * - Redis Streams: Work queues with consumer groups, XAUTOCLAIM for recovery
 * - RedPanda: Event logs only (NOT work queues)
 * - ActivityPods: Signing API (keys never leave), inbox forwarding
 */

import Fastify from "fastify";
import Redis from "ioredis";
import {
  RedisStreamsQueue,
  createDefaultConfig as createQueueConfig,
  createInboundEnvelope,
  OutboundJob,
} from "./queue/sidecar-redis-queue.js";
import { createSigningClient } from "./signing/signing-client.js";
import { createRedPandaProducer } from "./streams/redpanda-producer.js";
import { createOpenSearchIndexer } from "./streams/opensearch-indexer.js";
import { createOutboundWorker, OutboundWorker } from "./delivery/outbound-worker.js";
import { createInboundWorker, InboundWorker } from "./delivery/inbound-worker.js";
import { logger } from "./utils/logger.js";
import { registerAtXrpcRoutes, attachSubscribeReposWebSocket } from "./at-adapter/xrpc/AtXrpcFastifyBridge.js";
// AT adapter — identity
import { RedisIdentityBindingRepository } from "./core-domain/identity/RedisIdentityBindingRepository.js";
// AT adapter — repo / alias
import { RedisAtAliasStore } from "./at-adapter/repo/AtAliasStore.js";
import { RedisAtprotoRepoRegistry } from "./atproto/repo/AtprotoRepoRegistry.js";
import { DefaultAtRecordReader } from "./at-adapter/repo/AtRecordReader.js";
import { DefaultAtCarExporter } from "./at-adapter/repo/AtCarExporter.js";
import { DefaultAtRkeyService } from "./at-adapter/repo/AtRkeyService.js";
import { DefaultAtRecordRefResolver } from "./at-adapter/repo/AtRecordRefResolver.js";
import { DefaultAtTargetAliasResolver } from "./at-adapter/repo/AtTargetAliasResolver.js";
import { DefaultAtCommitBuilder } from "./at-adapter/repo/AtCommitBuilder.js";
import { DefaultAtCommitPersistenceService } from "./at-adapter/repo/AtCommitPersistenceService.js";
// AT adapter — identity / handle
import { DefaultHandleResolutionReader } from "./at-adapter/identity/HandleResolutionReader.js";
import { DefaultAtSubjectResolver } from "./at-adapter/identity/AtSubjectResolver.js";
import { HttpIdentityBindingSyncService } from "./at-adapter/identity/IdentityBindingSyncService.js";
// AT adapter — firehose
import { DefaultAtFirehoseSubscriptionManager } from "./at-adapter/firehose/AtFirehoseSubscriptionManager.js";
import { InMemoryAtFirehoseCursorStore } from "./at-adapter/firehose/AtFirehoseCursorStore.js";
// AT adapter — auth / session
import { DefaultAtSessionTokenService } from "./at-adapter/auth/DefaultAtSessionTokenService.js";
import { DefaultAtAccountResolver } from "./at-adapter/auth/DefaultAtAccountResolver.js";
import { DefaultAtSessionService } from "./at-adapter/auth/DefaultAtSessionService.js";
import { createHttpAtPasswordVerifier } from "./at-adapter/auth/HttpAtPasswordVerifier.js";
import { LocalAtPasswordVerifier } from "./at-adapter/auth/LocalAtPasswordVerifier.js";
// AT local fixture signing (dev/test only — activated by AT_LOCAL_FIXTURE=true)
import { LocalAtSigningService } from "./signing/LocalAtSigningService.js";
// AT adapter — projection
import { DefaultAtProjectionPolicy } from "./at-adapter/projection/AtProjectionPolicy.js";
import { DefaultAtProjectionWorker } from "./at-adapter/projection/AtProjectionWorker.js";
import { DefaultProfileRecordSerializer } from "./at-adapter/projection/serializers/ProfileRecordSerializer.js";
import { DefaultPostRecordSerializer } from "./at-adapter/projection/serializers/PostRecordSerializer.js";
import { DefaultFacetBuilder } from "./at-adapter/projection/serializers/FacetBuilder.js";
import { DefaultEmbedBuilder } from "./at-adapter/projection/serializers/EmbedBuilder.js";
import { DefaultImageEmbedBuilder } from "./at-adapter/projection/serializers/ImageEmbedBuilder.js";
import { DefaultFollowRecordSerializer } from "./at-adapter/projection/serializers/FollowRecordSerializer.js";
import { DefaultLikeRecordSerializer } from "./at-adapter/projection/serializers/LikeRecordSerializer.js";
import { DefaultRepostRecordSerializer } from "./at-adapter/projection/serializers/RepostRecordSerializer.js";
// AT adapter — writes
import { DefaultAtWriteNormalizer } from "./at-adapter/writes/DefaultAtWriteNormalizer.js";
import { DefaultAtWritePolicyGate } from "./at-adapter/writes/DefaultAtWritePolicyGate.js";
import { DefaultAtWriteGateway } from "./at-adapter/writes/DefaultAtWriteGateway.js";
import { DefaultCanonicalClientWriteService } from "./at-adapter/writes/DefaultCanonicalClientWriteService.js";
import { RedisAtWriteResultStore } from "./at-adapter/writes/AtWriteResultStore.js";
import type { AtWriteResultStore } from "./at-adapter/writes/AtWriteResultStore.js";
// Signing + event contracts
import type { SigningService } from "./core-domain/contracts/SigningContracts.js";
import type { EventPublisher } from "./core-domain/events/CoreIdentityEvents.js";

// ============================================================================
// Configuration
// ============================================================================

const config = {
  version: process.env.VERSION || "5.0.0",
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "8080", 10),
  host: process.env.HOST || "0.0.0.0",
  domain: process.env.DOMAIN || "localhost",
  sidecarToken: process.env.SIDECAR_TOKEN || "",
  
  // Feature flags
  enableOutboundWorker: process.env.ENABLE_OUTBOUND_WORKER !== "false",
  enableInboundWorker: process.env.ENABLE_INBOUND_WORKER !== "false",
  enableOpenSearchIndexer: process.env.ENABLE_OPENSEARCH_INDEXER !== "false",
  enableXrpcServer: process.env.ENABLE_XRPC_SERVER !== "false",

  // Phase 7: AT session token secret (min 32 chars).
  // Required when ENABLE_XRPC_SERVER is true.
  atSessionSecret: process.env.AT_SESSION_SECRET || "",

  // Phase 7: PDS hostname advertised in server.describeServer
  atPdsHostname: process.env.AT_PDS_HOSTNAME || process.env.DOMAIN || "localhost",

  // Phase 7: durable write-result correlation settings
  atWriteResultTtlSec: Number.parseInt(process.env.AT_WRITE_RESULT_TTL_SEC || "120", 10),
  atWriteResultKeyPrefix: process.env.AT_WRITE_RESULT_KEY_PREFIX || "at:write-result",
  atWriteResultChannelPrefix: process.env.AT_WRITE_RESULT_CHANNEL_PREFIX || "at:write-result:ch",

  // Local fixture mode — for development / integration testing ONLY.
  // When true: uses LocalAtPasswordVerifier (no ActivityPods auth call) and
  // LocalAtSigningService (secp256k1 signing from Redis-stored fixture keys).
  // NEVER set in production.  Requires provision-test-fixture.ts to have been run.
  atLocalFixture: process.env.AT_LOCAL_FIXTURE === "true",
};

// ============================================================================
// Global State
// ============================================================================

let queue: RedisStreamsQueue | null = null;
let outboundWorker: OutboundWorker | null = null;
let inboundWorker: InboundWorker | null = null;
let opensearchIndexer: ReturnType<typeof createOpenSearchIndexer> | null = null;
let atRedisClient: Redis | null = null;
let writeResultStore: AtWriteResultStore | null = null;
let isShuttingDown = false;

// ============================================================================
// Main Application
// ============================================================================

async function main() {
  logger.info("Starting Fedify Sidecar for ActivityPods", {
    version: config.version,
    nodeEnv: config.nodeEnv,
  });

  if (config.enableXrpcServer && !config.atLocalFixture) {
    if (!process.env.ACTIVITYPODS_URL) {
      throw new Error("ENABLE_XRPC_SERVER requires ACTIVITYPODS_URL when AT_LOCAL_FIXTURE is false");
    }
    if (!process.env.ACTIVITYPODS_TOKEN) {
      throw new Error("ENABLE_XRPC_SERVER requires ACTIVITYPODS_TOKEN when AT_LOCAL_FIXTURE is false");
    }
  }

  // Fixture mode banner — unmistakable, fires before any service connections
  if (config.atLocalFixture) {
    let fixtureAccountIds: string[] = [];
    try {
      const raw = process.env['AT_LOCAL_FIXTURE_CREDS'];
      const creds = raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : { 'http://localhost:3000/atproto365133': '(default)' };
      fixtureAccountIds = Object.keys(creds);
    } catch {
      fixtureAccountIds = ['(parse error — using defaults)'];
    }
    const accountList = fixtureAccountIds.map((id) => `    • ${id}`).join('\n');
    process.stderr.write(
      `\n${'='.repeat(72)}\n` +
      `  WARNING: AT_LOCAL_FIXTURE=true — LOCAL FIXTURE MODE ENABLED\n` +
      `  LocalAtPasswordVerifier + LocalAtSigningService are ACTIVE.\n` +
      `  ActivityPods auth and signing endpoints are BYPASSED.\n` +
      `  NEVER deploy with this flag set.\n` +
      `  Fixture accounts (${fixtureAccountIds.length}):\n` +
      accountList + '\n' +
      `${'='.repeat(72)}\n\n`,
    );
  }

  // Register shutdown handlers
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error: error.message, stack: error.stack });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { reason });
    shutdown("unhandledRejection");
  });

  try {
    // Initialize Redis Streams queue
    const queueConfig = createQueueConfig();
    queue = new RedisStreamsQueue(queueConfig);
    await queue.connect();
    logger.info("Redis Streams queue connected");

    // Initialize Signing client
    const signingClient = createSigningClient();
    logger.info("Signing client initialized");

    // Initialize RedPanda producer only when worker/indexer features need it.
    const redpandaRequired =
      config.enableOpenSearchIndexer ||
      config.enableOutboundWorker ||
      config.enableInboundWorker;

    let redpanda: any = null;
    if (redpandaRequired) {
      redpanda = createRedPandaProducer();
      await redpanda.connect();
      logger.info("RedPanda producer connected");
    } else {
      logger.info("RedPanda producer skipped (workers/indexer disabled)");
    }

    // Initialize OpenSearch indexer
    if (config.enableOpenSearchIndexer) {
      opensearchIndexer = createOpenSearchIndexer();
      await opensearchIndexer.initialize();
      opensearchIndexer.start().catch(err => {
        logger.error("OpenSearch indexer error", { error: err.message });
      });
      logger.info("OpenSearch indexer started");
    }

    // Initialize outbound worker
    if (config.enableOutboundWorker) {
      outboundWorker = createOutboundWorker(queue, signingClient, redpanda);
      outboundWorker.start().catch(err => {
        logger.error("Outbound worker error", { error: err.message });
      });
      logger.info("Outbound worker started");
    }

    // Initialize inbound worker
    if (config.enableInboundWorker) {
      inboundWorker = createInboundWorker(queue, redpanda);
      inboundWorker.start().catch(err => {
        logger.error("Inbound worker error", { error: err.message });
      });
      logger.info("Inbound worker started");
    }

    // Create HTTP server
    const app = Fastify({
      logger: false,
      trustProxy: true,
      bodyLimit: 1024 * 1024,  // 1MB
    });
    let xrpcServerForWebSocket: any = null;

    // Raw body parser for signature verification
    app.addContentTypeParser(
      ["application/activity+json", "application/ld+json", "application/json"],
      { parseAs: "string" },
      (req, body, done) => {
        done(null, body);
      }
    );

    // Health check endpoint
    app.get("/health", async () => {
      return {
        status: "ok",
        version: config.version,
        uptime: process.uptime(),
      };
    });

    // Readiness check endpoint
    app.get("/ready", async () => {
      if (!queue) {
        return { status: "not_ready", reason: "Queue not initialized" };
      }
      
      const outboundPending = await queue.getPendingCount("outbound");
      const inboundPending = await queue.getPendingCount("inbound");
      
      return {
        status: "ready",
        queues: {
          outbound: { pending: outboundPending },
          inbound: { pending: inboundPending },
        },
        workers: {
          outbound: config.enableOutboundWorker,
          inbound: config.enableInboundWorker,
          opensearch: config.enableOpenSearchIndexer,
        },
      };
    });

    // Metrics endpoint (Prometheus format)
    app.get("/metrics", async () => {
      if (!queue) {
        return "# Queue not initialized\n";
      }
      
      const outboundPending = await queue.getPendingCount("outbound");
      const inboundPending = await queue.getPendingCount("inbound");
      const outboundLength = await queue.getStreamLength("outbound");
      const inboundLength = await queue.getStreamLength("inbound");
      
      return [
        `# HELP fedify_outbound_pending Number of pending outbound jobs`,
        `# TYPE fedify_outbound_pending gauge`,
        `fedify_outbound_pending ${outboundPending}`,
        `# HELP fedify_inbound_pending Number of pending inbound envelopes`,
        `# TYPE fedify_inbound_pending gauge`,
        `fedify_inbound_pending ${inboundPending}`,
        `# HELP fedify_outbound_stream_length Total outbound stream length`,
        `# TYPE fedify_outbound_stream_length gauge`,
        `fedify_outbound_stream_length ${outboundLength}`,
        `# HELP fedify_inbound_stream_length Total inbound stream length`,
        `# TYPE fedify_inbound_stream_length gauge`,
        `fedify_inbound_stream_length ${inboundLength}`,
        `# HELP fedify_uptime_seconds Uptime in seconds`,
        `# TYPE fedify_uptime_seconds gauge`,
        `fedify_uptime_seconds ${Math.floor(process.uptime())}`,
      ].join("\n") + "\n";
    });

    // Shared inbox endpoint
    app.post("/inbox", async (request, reply) => {
      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      
      const envelope = createInboundEnvelope({
        method: "POST",
        path: "/inbox",
        headers: normalizeHeaders(request.headers),
        body: request.body as string,
        remoteIp: request.ip,
      });

      await queue.enqueueInbound(envelope);
      
      reply.status(202).send({ accepted: true, envelopeId: envelope.envelopeId });
    });

    // Per-user inbox endpoint
    app.post("/users/:username/inbox", async (request, reply) => {
      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      
      const { username } = request.params as { username: string };
      
      const envelope = createInboundEnvelope({
        method: "POST",
        path: `/users/${username}/inbox`,
        headers: normalizeHeaders(request.headers),
        body: request.body as string,
        remoteIp: request.ip,
      });

      await queue.enqueueInbound(envelope);
      
      reply.status(202).send({ accepted: true, envelopeId: envelope.envelopeId });
    });

    // Alternative inbox path format
    app.post("/:username/inbox", async (request, reply) => {
      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      
      const { username } = request.params as { username: string };
      
      const envelope = createInboundEnvelope({
        method: "POST",
        path: `/${username}/inbox`,
        headers: normalizeHeaders(request.headers),
        body: request.body as string,
        remoteIp: request.ip,
      });

      await queue.enqueueInbound(envelope);
      
      reply.status(202).send({ accepted: true, envelopeId: envelope.envelopeId });
    });

    // Outbound webhook — receives delivery work from ActivityPods
    app.post("/webhook/outbox", async (request, reply) => {
      const authHeader = (request.headers["authorization"] as string) || "";
      const [scheme, token] = authHeader.split(" ");
      if (scheme !== "Bearer" || token !== config.sidecarToken) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      const body = request.body as any;
      if (!body?.actorUri || !body?.activity || !Array.isArray(body?.remoteTargets)) {
        reply.status(400).send({ error: "Bad Request" });
        return;
      }
      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      const activityJson = JSON.stringify(body.activity);
      let jobCount = 0;
      for (const target of body.remoteTargets) {
        if (!target.inboxUrl || !target.targetDomain) continue;
        const deliveryUrl = target.sharedInboxUrl || target.inboxUrl;
        const job: OutboundJob = {
          jobId: `${body.activityId}::${deliveryUrl}`,
          activityId: body.activityId,
          actorUri: body.actorUri,
          activity: activityJson,
          targetInbox: deliveryUrl,
          targetDomain: target.targetDomain,
          attempt: 0,
          maxAttempts: 10,
          notBeforeMs: 0,
        };
        await queue.enqueueOutbound(job);
        jobCount++;
      }
      reply.status(202).send({ accepted: true, jobCount });
    });

    // -----------------------------------------------------------------------
    // Phase 7: AT XRPC Server
    // Wire all /xrpc/* routes and the subscribeRepos WebSocket endpoint onto
    // the already-listening Fastify app.
    //
    // All concrete dependencies are now wired.  The signing client (already
    // instantiated above) is adapted to the SigningService interface so it can
    // be consumed by DefaultAtCommitBuilder without a separate HTTP adapter.
    // -----------------------------------------------------------------------
    if (config.enableXrpcServer) {
      try {
        const { DefaultAtXrpcServer } = await import("./at-adapter/xrpc/AtXrpcServer.js");

        // ---- Shared Redis client for AT adapter stores ----
        const atRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
        atRedisClient = atRedis;
        atRedis.on("error", (err: Error) =>
          logger.error("AT Redis client error", { error: err.message }),
        );

        // ---- Identity binding repository ----
        const identityRepo = new RedisIdentityBindingRepository(atRedis);

        // ---- Repo / alias stores ----
        const aliasStore   = new RedisAtAliasStore(atRedis);
        const repoRegistry = new RedisAtprotoRepoRegistry(atRedis);

        // ---- Handle resolution ----
        const handleResolutionReader = new DefaultHandleResolutionReader(identityRepo);

        // ---- Record reader + CAR exporter ----
        const recordReader = new DefaultAtRecordReader(
          handleResolutionReader,
          aliasStore,
          repoRegistry,
        );
        const carExporter = new DefaultAtCarExporter(repoRegistry);

        // ---- Firehose ----
        const firehoseCursorStore   = new InMemoryAtFirehoseCursorStore();
        const firehoseSubscriptions = new DefaultAtFirehoseSubscriptionManager(firehoseCursorStore);

        // ---- Session service ----
        const sessionSecret =
          config.atSessionSecret ||
          "dev-session-secret-at-least-32-characters";
        const sessionEndpointEnabled = true;
        let sessionService: any = undefined;
        let accountResolverForSession: any = undefined;
        let passwordVerifierForSession: any = undefined;
        let identityBindingSyncService: HttpIdentityBindingSyncService | undefined = undefined;
        if (sessionEndpointEnabled) {
          const tokenService    = new DefaultAtSessionTokenService({ secret: sessionSecret });
          identityBindingSyncService = config.atLocalFixture
            ? undefined
            : new HttpIdentityBindingSyncService({
                backendBaseUrl: process.env.ACTIVITYPODS_URL!,
                bearerToken: process.env.ACTIVITYPODS_TOKEN!,
                identityBindingRepository: identityRepo,
                logger,
              });

          if (identityBindingSyncService) {
            logger.info("AT identity sync enabled", {
              backendBaseUrl: process.env.ACTIVITYPODS_URL,
            });
          }

          const accountResolver = new DefaultAtAccountResolver(
            identityRepo,
            identityBindingSyncService,
            logger,
          );

          // Local fixture mode: bypass ActivityPods auth (dev/test only)
          const passwordVerifier = config.atLocalFixture
            ? new LocalAtPasswordVerifier()
            : createHttpAtPasswordVerifier({
                baseUrl: process.env.ACTIVITYPODS_URL ?? "http://localhost:3000",
                token:   process.env.ACTIVITYPODS_TOKEN ?? "",
              });

          accountResolverForSession  = accountResolver;
          passwordVerifierForSession = passwordVerifier;
          sessionService = new DefaultAtSessionService(
            accountResolver,
            passwordVerifier,
            tokenService,
          );
        }

        // ---- Signing adapter (SigningClient → SigningService) ----
        // Local fixture mode: use in-process secp256k1 signing from Redis-stored keys.
        // Production mode:    proxy signing calls to the ActivityPods signing API.
        const signingServiceAdapter: SigningService = config.atLocalFixture
          ? new LocalAtSigningService(atRedis)
          : {
              signAtprotoCommit:  (req) => signingClient.signAtprotoCommit(req),
              signPlcOperation:   (req) => signingClient.signAtprotoPlcOp(req),
              getAtprotoPublicKey: (req) => signingClient.getAtprotoPublicKey(req),
              generateApSigningKey: () => { throw new Error("generateApSigningKey not available via sidecar"); },
              generateAtSigningKey: () => { throw new Error("generateAtSigningKey not available via sidecar"); },
              getApPublicKey:       () => { throw new Error("getApPublicKey not available via sidecar"); },
            };

        // ---- Event publisher adapter (no-op logger; AT repo events are
        //      handled in-process via alias store + repo registry) ----
        const eventPublisherAdapter: EventPublisher = {
          publish: async (topic, event) => {
            logger.debug("AT event published (no-op)", { topic, eventType: (event as any)?.type });
          },
          publishBatch: async (events) => {
            for (const { topic, event } of events) {
              logger.debug("AT event published (no-op)", { topic, eventType: (event as any)?.type });
            }
          },
        };

        // ---- Projection worker ----
        const rkeyService          = new DefaultAtRkeyService();
        const recordRefResolver    = new DefaultAtRecordRefResolver(aliasStore);
        const subjectResolver      = new DefaultAtSubjectResolver(identityRepo);
        const targetAliasResolver  = new DefaultAtTargetAliasResolver(aliasStore);
        const commitBuilder        = new DefaultAtCommitBuilder(signingServiceAdapter);
        const persistenceService   = new DefaultAtCommitPersistenceService(
          aliasStore,
          eventPublisherAdapter,
          atRedis,
        );

        const projectionWorker = new DefaultAtProjectionWorker(
          new DefaultAtProjectionPolicy(),
          identityRepo,
          repoRegistry,
          new DefaultProfileRecordSerializer(),
          new DefaultPostRecordSerializer(),
          rkeyService,
          aliasStore,
          commitBuilder,
          persistenceService,
          eventPublisherAdapter,
          {
            mediaResolver:       { resolveAvatarBlob: async () => null, resolveBannerBlob: async () => null },
            facetBuilder:        new DefaultFacetBuilder(),
            embedBuilder:        new DefaultEmbedBuilder(new DefaultImageEmbedBuilder()),
            recordRefResolver,
            subjectResolver,
            targetAliasResolver,
            followSerializer:    new DefaultFollowRecordSerializer(),
            likeSerializer:      new DefaultLikeRecordSerializer(),
            repostSerializer:    new DefaultRepostRecordSerializer(),
          },
        );

        // ---- Write gateway ----
        const resultStore   = new RedisAtWriteResultStore({
          redis: atRedis,
          resultTtlSec: Number.isFinite(config.atWriteResultTtlSec)
            ? config.atWriteResultTtlSec
            : 120,
          keyPrefix: config.atWriteResultKeyPrefix,
          channelPrefix: config.atWriteResultChannelPrefix,
        });
        writeResultStore = resultStore;
        const writeService  = new DefaultCanonicalClientWriteService({
          projectionWorker,
          aliasStore,
          resultStore,
          identityRepo,
        });
        const writeGateway  = new DefaultAtWriteGateway({
          normalizer:  new DefaultAtWriteNormalizer(),
          policyGate:  new DefaultAtWritePolicyGate(identityRepo, aliasStore),
          writeService,
          resultStore,
          identityBindingSyncService,
          logger,
        });

        // ---- Assemble XRPC server ----
        const xrpcServer = new DefaultAtXrpcServer({
          recordReader,
          carExporter,
          handleResolutionReader,
          firehoseSubscriptions,
          repoRegistry,
          identityRepo,
          serverConfig: {
            hostname:           config.atPdsHostname,
            inviteCodeRequired: false,
            acceptsNewAccounts: false,
          },
          sessionService,
          accountResolver: accountResolverForSession,
          passwordVerifier: passwordVerifierForSession,
          writeGateway,
        });

        registerAtXrpcRoutes(app, { xrpcServer, sessionService });
        xrpcServerForWebSocket = xrpcServer;

        if (config.atLocalFixture) {
          logger.warn(
            "AT_LOCAL_FIXTURE=true — LocalAtPasswordVerifier and LocalAtSigningService are active. " +
            "This mode bypasses ActivityPods auth and uses Redis-stored fixture keys. " +
            "NEVER use in production."
          );
        }

        logger.info("AT XRPC server routes registered", {
          hostname:              config.atPdsHostname,
          writeEndpointsEnabled: true,
          sessionEndpointEnabled,
          localFixtureMode:      config.atLocalFixture,
        });
      } catch (err: any) {
        logger.error({
          error: err.message,
          stack: err.stack,
        }, "Failed to initialise AT XRPC server");
      }
    }

    if (xrpcServerForWebSocket) {
      attachSubscribeReposWebSocket(app, xrpcServerForWebSocket);
    }

    // Start HTTP server only after all HTTP and WebSocket routes are registered.
    await app.listen({ port: config.port, host: config.host });

    logger.info(`Fedify Sidecar listening on ${config.host}:${config.port}`);
    logger.info(`Metrics available at http://${config.host}:${config.port}/metrics`);
    logger.info("Configuration summary", {
      domain: config.domain,
      enableOutboundWorker: config.enableOutboundWorker,
      enableInboundWorker: config.enableInboundWorker,
      enableOpenSearchIndexer: config.enableOpenSearchIndexer,
    });

  } catch (error: any) {
    logger.error({ error: error.message, stack: error.stack }, "Failed to start Fedify Sidecar");
    process.exit(1);
  }
}

/**
 * Normalize headers to lowercase keys
 */
function normalizeHeaders(headers: Record<string, any>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value[0];
    }
  }
  return normalized;
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress");
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, 30000);

  try {
    // Stop workers first
    if (outboundWorker) {
      await outboundWorker.stop();
      logger.info("Outbound worker stopped");
    }

    if (inboundWorker) {
      await inboundWorker.stop();
      logger.info("Inbound worker stopped");
    }

    if (opensearchIndexer) {
      await opensearchIndexer.stop();
      logger.info("OpenSearch indexer stopped");
    }

    // Disconnect queue
    if (queue) {
      await queue.disconnect();
      logger.info("Redis Streams queue disconnected");
    }

    // Close write-result store (drains pending waiters + quits subscriber)
    if (writeResultStore) {
      await writeResultStore.close();
      logger.info("Write result store closed");
    }

    // Quit shared AT Redis client
    if (atRedisClient) {
      await atRedisClient.quit().catch(() => atRedisClient!.disconnect());
      logger.info("AT Redis client disconnected");
    }

    clearTimeout(shutdownTimeout);
    logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error: any) {
    logger.error("Error during shutdown", { error: error.message });
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// Start the application
main();
