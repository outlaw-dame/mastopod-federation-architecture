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
