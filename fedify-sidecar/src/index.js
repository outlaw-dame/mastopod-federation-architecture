import express from 'express';
import config from './config/index.js';
import logger from './utils/logger.js';
import redpandaService from './services/redpanda.js';
import opensearchService from './services/opensearch.js';
import deliveryService from './services/delivery.js';
import inboxHandler from './handlers/inbox.js';
import sharedInboxHandler from './handlers/shared-inbox.js';
import webFingerHandler from './handlers/webfinger.js';
import actorHandler from './handlers/actor.js';

/**
 * ActivityPods Fedify Sidecar v2
 * 
 * This sidecar handles all federation-related tasks for ActivityPods:
 * - Inbound activity processing with signature verification → Stream2
 * - Outbound activity delivery from Stream1 → Remote inboxes
 * - WebFinger and actor document serving
 * - Shared inbox for efficient delivery
 * - OpenSearch indexing from Firehose
 * 
 * Key Architecture:
 * - ActivityPods handles local federation (no HTTP)
 * - Fedify handles remote federation (HTTP)
 * - RedPanda provides streaming backbone
 * - OpenSearch provides queryable activity store
 */

const app = express();

// Middleware
app.use(express.json({
  type: ['application/json', 'application/activity+json', 'application/ld+json'],
  limit: '1mb',
}));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (config.logLevel === 'debug') {
      logger.debug(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    services: {
      redpanda: redpandaService.isConnected ? 'connected' : 'disconnected',
      opensearch: opensearchService.isConnected ? 'connected' : 'disconnected',
    },
  };

  const isHealthy = health.services.redpanda === 'connected' && 
                    health.services.opensearch === 'connected';

  res.status(isHealthy ? 200 : 503).json(health);
});

// Statistics endpoint
app.get('/stats', (req, res) => {
  res.json({
    delivery: deliveryService.getStats(),
    opensearch: opensearchService.getStats(),
    sharedInbox: sharedInboxHandler.getStats(),
    timestamp: new Date().toISOString(),
  });
});

// Search endpoint (queries OpenSearch)
app.get('/api/search', async (req, res) => {
  try {
    const results = await opensearchService.search({
      q: req.query.q,
      type: req.query.type,
      actor: req.query.actor,
      domain: req.query.domain,
      origin: req.query.origin,
      from: parseInt(req.query.from) || 0,
      size: parseInt(req.query.size) || 20,
    });
    res.json(results);
  } catch (err) {
    logger.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Aggregations endpoint
app.get('/api/aggregations', async (req, res) => {
  try {
    const results = await opensearchService.getAggregations({
      interval: req.query.interval || 'day',
      size: parseInt(req.query.size) || 10,
    });
    res.json(results);
  } catch (err) {
    logger.error('Aggregations error:', err);
    res.status(500).json({ error: 'Aggregations failed' });
  }
});

// WebFinger endpoint
app.get('/.well-known/webfinger', (req, res) => {
  webFingerHandler.handleWebFinger(req, res);
});

// NodeInfo endpoints (proxy to ActivityPods)
app.get('/.well-known/nodeinfo', async (req, res) => {
  try {
    const response = await fetch(`${config.activityPodsUrl}/.well-known/nodeinfo`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    logger.error('NodeInfo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Shared inbox endpoint
app.post('/inbox', (req, res) => {
  sharedInboxHandler.handleSharedInboxPost(req, res);
});

// User-specific endpoints
app.get('/users/:username', (req, res) => {
  actorHandler.handleActorRequest(req, res);
});

app.post('/users/:username/inbox', (req, res) => {
  inboxHandler.handleInboxPost(req, res);
});

app.get('/users/:username/outbox', (req, res) => {
  actorHandler.handleOutboxRequest(req, res);
});

app.get('/users/:username/followers', (req, res) => {
  actorHandler.handleFollowersRequest(req, res);
});

app.get('/users/:username/following', (req, res) => {
  actorHandler.handleFollowingRequest(req, res);
});

// Admin endpoints
app.post('/admin/block-domain', express.json(), async (req, res) => {
  const { domain, apiKey } = req.body;
  
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await inboxHandler.blockDomain(domain);
  res.json({ status: 'blocked', domain });
});

app.post('/admin/unblock-domain', express.json(), async (req, res) => {
  const { domain, apiKey } = req.body;
  
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await inboxHandler.unblockDomain(domain);
  res.json({ status: 'unblocked', domain });
});

app.post('/admin/clear-cache', express.json(), async (req, res) => {
  const { apiKey } = req.body;
  
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  webFingerHandler.clearCache();
  actorHandler.clearCache();
  res.json({ status: 'cache cleared' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/**
 * Initialize and start the server
 */
async function start() {
  try {
    logger.info('Starting ActivityPods Fedify Sidecar v2...');

    // Initialize RedPanda
    await redpandaService.initialize();
    await redpandaService.ensureTopics();

    // Initialize OpenSearch
    await opensearchService.initialize();

    // Initialize handlers
    await inboxHandler.initialize();

    // Initialize delivery service (consumes from Stream1)
    await deliveryService.initialize();

    // Start HTTP server
    app.listen(config.port, config.host, () => {
      logger.info(`Fedify sidecar listening on ${config.host}:${config.port}`);
      logger.info(`Base URL: ${config.baseUrl}`);
      logger.info(`ActivityPods URL: ${config.activityPodsUrl}`);
      logger.info(`RedPanda brokers: ${config.redpanda.brokers.join(', ')}`);
      logger.info(`OpenSearch node: ${config.opensearch.node}`);
    });

  } catch (err) {
    logger.error('Failed to start sidecar:', err);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  
  try {
    await opensearchService.close();
    await redpandaService.close();
  } catch (err) {
    logger.error('Error during shutdown:', err);
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the application
start();
