/**
 * Configuration for Fedify Sidecar
 * 
 * All configuration is loaded from environment variables.
 */

import { z } from "zod";

// Configuration schema with validation
const configSchema = z.object({
  // Server settings
  port: z.number().default(3001),
  host: z.string().default("0.0.0.0"),
  version: z.string().default("1.0.0"),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),

  // Domain settings
  domain: z.string().min(1),
  baseUrl: z.string().url(),

  // RedPanda settings
  redpanda: z.object({
    brokers: z.string().default("localhost:9092"),
    clientId: z.string().default("fedify-sidecar"),
    consumerGroupId: z.string().optional(),
  }),

  // ActivityPods settings
  activitypods: z.object({
    url: z.string().url(),
    signingApiUrl: z.string().url(),
    internalApiKey: z.string().optional(),
  }),

  // OpenSearch settings
  opensearch: z.object({
    node: z.string().url().default("http://localhost:9200"),
    username: z.string().optional(),
    password: z.string().optional(),
    indexPrefix: z.string().default("activitypods"),
    ssl: z.boolean().default(false),
  }),

  // Metrics settings
  metrics: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(9090),
    path: z.string().default("/metrics"),
  }),

  // Logging settings
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    format: z.enum(["json", "pretty"]).default("json"),
  }),

  // Delivery settings
  delivery: z.object({
    maxConcurrentDomains: z.number().default(50),
    maxConcurrentPerDomain: z.number().default(5),
    connectionPoolSize: z.number().default(10),
    signatureCacheTtlMs: z.number().default(300000), // 5 minutes
    maxRetries: z.number().default(8),
  }),

  // Stream settings
  streams: z.object({
    batchSize: z.number().default(100),
    batchTimeoutMs: z.number().default(1000),
    retentionMs: z.number().default(604800000), // 7 days
  }),
});

type Config = z.infer<typeof configSchema>;

/**
 * Load configuration from environment variables
 */
function loadConfig(): Config {
  const rawConfig = {
    port: parseInt(process.env.PORT ?? "3001", 10),
    host: process.env.HOST ?? "0.0.0.0",
    version: process.env.VERSION ?? "1.0.0",
    nodeEnv: process.env.NODE_ENV ?? "development",

    domain: process.env.DOMAIN ?? "localhost",
    baseUrl: process.env.BASE_URL ?? "http://localhost:3001",

    redpanda: {
      brokers: process.env.REDPANDA_BROKERS ?? "localhost:9092",
      clientId: process.env.REDPANDA_CLIENT_ID ?? "fedify-sidecar",
      consumerGroupId: process.env.REDPANDA_CONSUMER_GROUP_ID,
    },

    activitypods: {
      url: process.env.ACTIVITYPODS_URL ?? "http://localhost:3000",
      signingApiUrl: process.env.ACTIVITYPODS_SIGNING_API_URL ?? "http://localhost:3000/api/signing",
      internalApiKey: process.env.ACTIVITYPODS_INTERNAL_API_KEY,
    },

    opensearch: {
      node: process.env.OPENSEARCH_NODE ?? "http://localhost:9200",
      username: process.env.OPENSEARCH_USERNAME,
      password: process.env.OPENSEARCH_PASSWORD,
      indexPrefix: process.env.OPENSEARCH_INDEX_PREFIX ?? "activitypods",
      ssl: process.env.OPENSEARCH_SSL === "true",
    },

    metrics: {
      enabled: process.env.METRICS_ENABLED !== "false",
      port: parseInt(process.env.METRICS_PORT ?? "9090", 10),
      path: process.env.METRICS_PATH ?? "/metrics",
    },

    logging: {
      level: process.env.LOG_LEVEL ?? "info",
      format: process.env.LOG_FORMAT ?? "json",
    },

    delivery: {
      maxConcurrentDomains: parseInt(process.env.DELIVERY_MAX_CONCURRENT_DOMAINS ?? "50", 10),
      maxConcurrentPerDomain: parseInt(process.env.DELIVERY_MAX_CONCURRENT_PER_DOMAIN ?? "5", 10),
      connectionPoolSize: parseInt(process.env.DELIVERY_CONNECTION_POOL_SIZE ?? "10", 10),
      signatureCacheTtlMs: parseInt(process.env.DELIVERY_SIGNATURE_CACHE_TTL_MS ?? "300000", 10),
      maxRetries: parseInt(process.env.DELIVERY_MAX_RETRIES ?? "8", 10),
    },

    streams: {
      batchSize: parseInt(process.env.STREAMS_BATCH_SIZE ?? "100", 10),
      batchTimeoutMs: parseInt(process.env.STREAMS_BATCH_TIMEOUT_MS ?? "1000", 10),
      retentionMs: parseInt(process.env.STREAMS_RETENTION_MS ?? "604800000", 10),
    },
  };

  // Validate and return
  return configSchema.parse(rawConfig);
}

// Export singleton config
export const config = loadConfig();

// Export type for use in other modules
export type { Config };
