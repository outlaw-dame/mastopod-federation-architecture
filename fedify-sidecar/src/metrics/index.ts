/**
 * Prometheus Metrics for Fedify Sidecar
 * 
 * Provides comprehensive monitoring for:
 * - Delivery performance (latency, success/failure)
 * - Queue depth and processing
 * - Connection pooling
 * - Signature caching
 * - Stream processing
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

// Create a custom registry
export const registry = new Registry();

// Collect default Node.js metrics
collectDefaultMetrics({ register: registry });

// ============================================================================
// Delivery Metrics
// ============================================================================

export const deliveriesTotal = new Counter({
  name: "federation_deliveries_total",
  help: "Total number of delivery attempts",
  labelNames: ["domain", "type", "status"] as const,
  registers: [registry],
});

export const deliveryLatency = new Histogram({
  name: "federation_delivery_latency_seconds",
  help: "Delivery latency in seconds",
  labelNames: ["domain", "type", "status"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const deliveriesOptimized = new Counter({
  name: "federation_deliveries_optimized_total",
  help: "Number of deliveries saved by shared inbox optimization",
  labelNames: ["domain", "type"] as const,
  registers: [registry],
});

export const batchDeliveryDuration = new Histogram({
  name: "federation_batch_delivery_duration_seconds",
  help: "Duration of batch delivery processing",
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

// ============================================================================
// Queue Metrics
// ============================================================================

export const queueDepth = new Gauge({
  name: "federation_queue_depth",
  help: "Current depth of message queues",
  labelNames: ["topic"] as const,
  registers: [registry],
});

export const queueMessagesProcessed = new Counter({
  name: "federation_queue_messages_processed_total",
  help: "Total messages processed from queues",
  labelNames: ["topic", "status"] as const,
  registers: [registry],
});

export const queueProcessingLatency = new Histogram({
  name: "federation_queue_processing_latency_seconds",
  help: "Time from enqueue to processing completion",
  labelNames: ["topic"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [registry],
});

// ============================================================================
// Signature Metrics
// ============================================================================

export const signatureCacheHits = new Counter({
  name: "federation_signature_cache_hits_total",
  help: "HTTP signature cache hits",
  registers: [registry],
});

export const signatureCacheMisses = new Counter({
  name: "federation_signature_cache_misses_total",
  help: "HTTP signature cache misses",
  registers: [registry],
});

export const signatureGenerationLatency = new Histogram({
  name: "federation_signature_generation_latency_seconds",
  help: "Time to generate HTTP signatures",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [registry],
});

// ============================================================================
// Connection Pool Metrics
// ============================================================================

export const connectionPoolSize = new Gauge({
  name: "federation_connection_pool_size",
  help: "Number of connection pools (per domain)",
  registers: [registry],
});

export const activeConnections = new Gauge({
  name: "federation_active_connections",
  help: "Number of active HTTP connections",
  labelNames: ["domain"] as const,
  registers: [registry],
});

// ============================================================================
// Stream Metrics
// ============================================================================

export const streamMessagesPublished = new Counter({
  name: "federation_stream_messages_published_total",
  help: "Total messages published to streams",
  labelNames: ["stream"] as const,
  registers: [registry],
});

export const streamMessagesConsumed = new Counter({
  name: "federation_stream_messages_consumed_total",
  help: "Total messages consumed from streams",
  labelNames: ["stream"] as const,
  registers: [registry],
});

export const streamLag = new Gauge({
  name: "federation_stream_consumer_lag",
  help: "Consumer lag for stream topics",
  labelNames: ["stream", "partition"] as const,
  registers: [registry],
});

// ============================================================================
// Inbox Metrics
// ============================================================================

export const inboxActivitiesReceived = new Counter({
  name: "federation_inbox_activities_received_total",
  help: "Total activities received in inbox",
  labelNames: ["type", "source_domain"] as const,
  registers: [registry],
});

export const inboxSignatureVerification = new Counter({
  name: "federation_inbox_signature_verification_total",
  help: "HTTP signature verification results",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const inboxProcessingLatency = new Histogram({
  name: "federation_inbox_processing_latency_seconds",
  help: "Time to process incoming activities",
  labelNames: ["type"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

// ============================================================================
// OpenSearch Metrics
// ============================================================================

export const opensearchIndexLatency = new Histogram({
  name: "federation_opensearch_index_latency_seconds",
  help: "Time to index activities in OpenSearch",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const opensearchIndexTotal = new Counter({
  name: "federation_opensearch_index_total",
  help: "Total activities indexed in OpenSearch",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const opensearchBulkSize = new Histogram({
  name: "federation_opensearch_bulk_size",
  help: "Number of documents per bulk index operation",
  buckets: [1, 5, 10, 25, 50, 100, 250],
  registers: [registry],
});

// ============================================================================
// Error Metrics
// ============================================================================

export const errorsTotal = new Counter({
  name: "federation_errors_total",
  help: "Total errors by category",
  labelNames: ["category", "code"] as const,
  registers: [registry],
});

// ============================================================================
// Additional Delivery Metrics (for delivery worker)
// ============================================================================

export const deliverySuccess = new Counter({
  name: "fedify_delivery_success_total",
  help: "Total successful deliveries",
  labelNames: ["domain"] as const,
  registers: [registry],
});

export const deliveryRetries = new Counter({
  name: "fedify_delivery_retries_total",
  help: "Total delivery retries",
  labelNames: ["domain"] as const,
  registers: [registry],
});

export const deliveryDlq = new Counter({
  name: "fedify_delivery_dlq_total",
  help: "Total deliveries moved to DLQ",
  labelNames: ["domain"] as const,
  registers: [registry],
});

export const deliveryDuplicatesSkipped = new Counter({
  name: "fedify_delivery_duplicates_skipped_total",
  help: "Total duplicate deliveries skipped",
  labelNames: ["domain"] as const,
  registers: [registry],
});

// ============================================================================
// Additional Inbound Metrics
// ============================================================================

export const inboundReceived = new Counter({
  name: "fedify_inbound_received_total",
  help: "Total inbound activities received",
  labelNames: ["domain"] as const,
  registers: [registry],
});

export const inboundProcessed = new Counter({
  name: "fedify_inbound_processed_total",
  help: "Total inbound activities processed",
  labelNames: ["domain"] as const,
  registers: [registry],
});

export const inboundErrors = new Counter({
  name: "fedify_inbound_errors_total",
  help: "Total inbound processing errors",
  registers: [registry],
});

export const inboundSignatureFailures = new Counter({
  name: "fedify_inbound_signature_failures_total",
  help: "Total inbound signature verification failures",
  labelNames: ["domain"] as const,
  registers: [registry],
});

export const inboundLatency = new Histogram({
  name: "fedify_inbound_latency_seconds",
  help: "Inbound processing latency in seconds",
  labelNames: ["domain"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

export const inboundActivityPubActivities = new Counter({
  name: "fedify_inbound_activitypub_activities_total",
  help: "Total ActivityPub inbound activities by stage and activity type",
  labelNames: ["stage", "activity_type"] as const,
  registers: [registry],
});

// ============================================================================
// Outbound Webhook Metrics
// ============================================================================

export const outboundWebhookRequestsTotal = new Counter({
  name: "fedify_outbound_webhook_requests_total",
  help: "Total outbound webhook requests by terminal status",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const outboundWebhookTargetCount = new Histogram({
  name: "fedify_outbound_webhook_target_count",
  help: "Number of delivery targets submitted per outbound webhook request",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const outboundWebhookQueueingLatency = new Histogram({
  name: "fedify_outbound_webhook_queueing_latency_seconds",
  help: "Time spent validating and enqueueing outbound delivery jobs per webhook request",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const outboundWebhookTargetsDedupedTotal = new Counter({
  name: "fedify_outbound_webhook_targets_deduped_total",
  help: "Number of duplicate or invalid outbound webhook targets skipped before enqueue",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const outboundWebhookBackpressureRejectionsTotal = new Counter({
  name: "fedify_outbound_webhook_backpressure_rejections_total",
  help: "Number of outbound webhook requests rejected due to queue backpressure",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// ============================================================================
// Protocol Bridge Metrics
// ============================================================================

export const protocolBridgeProjectionOutcomes = new Counter({
  name: "fedify_protocol_bridge_projection_outcomes_total",
  help: "Protocol bridge projection outcomes by direction, outcome, and reason",
  labelNames: ["direction", "outcome", "reason"] as const,
  registers: [registry],
});

export const apRelaySubscriptionAttempts = new Counter({
  name: "fedify_ap_relay_subscription_attempts_total",
  help: "AP relay subscription outcomes by relay and status",
  labelNames: ["relay", "status"] as const,
  registers: [registry],
});

// ============================================================================
// Feed Metrics
// ============================================================================

export const feedRequestsTotal = new Counter({
  name: "fedify_feed_requests_total",
  help: "Feed API requests grouped by endpoint and terminal status",
  labelNames: ["endpoint", "status"] as const,
  registers: [registry],
});

export const feedRequestLatency = new Histogram({
  name: "fedify_feed_request_latency_seconds",
  help: "Feed API request latency in seconds by endpoint",
  labelNames: ["endpoint"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const feedHydrationOmissionsTotal = new Counter({
  name: "fedify_feed_hydration_omissions_total",
  help: "Hydration omissions grouped by omission reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const feedOpenSearchRetriesTotal = new Counter({
  name: "fedify_feed_opensearch_retries_total",
  help: "OpenSearch retry attempts made by feed components",
  labelNames: ["component", "reason"] as const,
  registers: [registry],
});

export const feedSearchReadRetriesTotal = new Counter({
  name: "fedify_feed_search_read_retries_total",
  help: "Retry attempts made by feed search read components grouped by backend",
  labelNames: ["backend", "component", "reason"] as const,
  registers: [registry],
});

export const feedStreamConnectionsTotal = new Counter({
  name: "fedify_feed_stream_connections_total",
  help: "Total durable stream connection attempts by transport and outcome",
  labelNames: ["transport", "outcome"] as const,
  registers: [registry],
});

export const feedStreamActiveConnections = new Gauge({
  name: "fedify_feed_stream_active_connections",
  help: "Current number of active durable stream connections by transport",
  labelNames: ["transport"] as const,
  registers: [registry],
});

export const feedStreamEnvelopesPublished = new Counter({
  name: "fedify_feed_stream_envelopes_published_total",
  help: "Total stream envelopes published to connections",
  labelNames: ["stream"] as const,
  registers: [registry],
});

// ============================================================================
// Capability Metrics
// ============================================================================

/**
 * Per-capability gate decisions.  `outcome` is one of:
 *   "allowed"          — gate check passed
 *   "denied_feature_disabled"   — capability is disabled
 *   "denied_limit_exceeded"     — plan limit was exceeded
 *   "denied_protocol_disabled"  — required protocol is inactive
 */
export const capabilityGateTotal = new Counter({
  name: "fedify_capability_gate_total",
  help: "Total capability gate decisions by capability and outcome",
  labelNames: ["capability", "outcome"] as const,
  registers: [registry],
});

/**
 * Per-capability readiness gauge.
 *   1  = enabled
 *   0  = disabled
 *  -1  = degraded (enabled but dependency unavailable)
 */
export const capabilityHealthGauge = new Gauge({
  name: "fedify_capability_health",
  help: "Current health status of each declared capability (1=enabled, 0=disabled, -1=degraded)",
  labelNames: ["capability"] as const,
  registers: [registry],
});

// ============================================================================
// Aggregated Metrics Object
// ============================================================================

export const metrics = {
  // Delivery
  deliveriesTotal,
  deliveryLatency,
  deliveriesOptimized,
  batchDeliveryDuration,
  
  // Queue
  queueDepth,
  queueMessagesProcessed,
  queueProcessingLatency,
  
  // Signature
  signatureCacheHits,
  signatureCacheMisses,
  signatureGenerationLatency,
  
  // Connection
  connectionPoolSize,
  activeConnections,
  
  // Stream
  streamMessagesPublished,
  streamMessagesConsumed,
  streamLag,
  
  // Inbox
  inboxActivitiesReceived,
  inboxSignatureVerification,
  inboxProcessingLatency,
  
  // OpenSearch
  opensearchIndexLatency,
  opensearchIndexTotal,
  opensearchBulkSize,
  
  // Errors
  errorsTotal,
  
  // Additional delivery metrics
  deliverySuccess,
  deliveryRetries,
  deliveryDlq,
  deliveryDuplicatesSkipped,
  
  // Additional inbound metrics
  inboundReceived,
  inboundProcessed,
  inboundErrors,
  inboundSignatureFailures,
  inboundLatency,
  inboundActivityPubActivities,

  // Outbound webhook
  outboundWebhookRequestsTotal,
  outboundWebhookTargetCount,
  outboundWebhookQueueingLatency,
  outboundWebhookTargetsDedupedTotal,
  outboundWebhookBackpressureRejectionsTotal,

  // Protocol bridge
  protocolBridgeProjectionOutcomes,

  // AP relay
  apRelaySubscriptionAttempts,

  // Feed
  feedRequestsTotal,
  feedRequestLatency,
  feedHydrationOmissionsTotal,
  feedOpenSearchRetriesTotal,
  feedSearchReadRetriesTotal,
  feedStreamConnectionsTotal,
  feedStreamActiveConnections,
  feedStreamEnvelopesPublished,

  // Capability
  capabilityGateTotal,
  capabilityHealthGauge,
};

/**
 * Get all metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Get metrics content type
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
