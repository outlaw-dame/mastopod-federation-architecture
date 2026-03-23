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
import { 
  RedisStreamsQueue, 
  createDefaultConfig as createQueueConfig,
  createInboundEnvelope,
} from "./queue/sidecar-redis-queue.js";
import { createSigningClient } from "./signing/signing-client.js";
import { createRedPandaProducer } from "./streams/redpanda-producer.js";
import { createOpenSearchIndexer } from "./streams/opensearch-indexer.js";
import { createOutboundWorker, OutboundWorker } from "./delivery/outbound-worker.js";
import { createInboundWorker, InboundWorker } from "./delivery/inbound-worker.js";
import { logger } from "./utils/logger.js";

// ============================================================================
// Configuration
// ============================================================================

const config = {
  version: process.env.VERSION || "5.0.0",
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "8080", 10),
  host: process.env.HOST || "0.0.0.0",
  domain: process.env.DOMAIN || "localhost",
  
  // Feature flags
  enableOutboundWorker: process.env.ENABLE_OUTBOUND_WORKER !== "false",
  enableInboundWorker: process.env.ENABLE_INBOUND_WORKER !== "false",
  enableOpenSearchIndexer: process.env.ENABLE_OPENSEARCH_INDEXER !== "false",
};

// ============================================================================
// Global State
// ============================================================================

let queue: RedisStreamsQueue | null = null;
let outboundWorker: OutboundWorker | null = null;
let inboundWorker: InboundWorker | null = null;
let opensearchIndexer: ReturnType<typeof createOpenSearchIndexer> | null = null;
let isShuttingDown = false;

// ============================================================================
// Main Application
// ============================================================================

async function main() {
  logger.info("Starting Fedify Sidecar for ActivityPods", { 
    version: config.version,
    nodeEnv: config.nodeEnv,
  });

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

    // Initialize RedPanda producer
    const redpanda = createRedPandaProducer();
    await redpanda.connect();
    logger.info("RedPanda producer connected");

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

    // Start HTTP server
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
    logger.error("Failed to start Fedify Sidecar", { error: error.message, stack: error.stack });
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
