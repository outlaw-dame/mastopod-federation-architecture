import 'dotenv/config';

/**
 * Configuration for the Fedify sidecar
 * All values can be overridden via environment variables
 */
export const config = {
  // Server configuration
  port: parseInt(process.env.FEDIFY_PORT || '3001', 10),
  host: process.env.FEDIFY_HOST || '0.0.0.0',
  
  // Base URLs
  baseUrl: process.env.FEDIFY_BASE_URL || 'http://localhost:3001',
  activityPodsUrl: process.env.ACTIVITYPODS_URL || 'http://localhost:3000',
  
  // RedPanda configuration (Kafka-compatible)
  redpanda: {
    brokers: (process.env.REDPANDA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.REDPANDA_CLIENT_ID || 'fedify-sidecar',
    // Topic names
    topics: {
      stream1: process.env.TOPIC_STREAM1 || 'stream1-local-public',
      stream2: process.env.TOPIC_STREAM2 || 'stream2-remote-public',
      firehose: process.env.TOPIC_FIREHOSE || 'firehose',
    },
    // Consumer group IDs
    consumerGroups: {
      delivery: process.env.CONSUMER_GROUP_DELIVERY || 'fedify-delivery',
      indexer: process.env.CONSUMER_GROUP_INDEXER || 'fedify-indexer',
    },
    // Producer settings
    producer: {
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    },
    // Consumer settings
    consumer: {
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      maxBytesPerPartition: 1048576, // 1MB
    },
  },
  
  // OpenSearch configuration
  opensearch: {
    node: process.env.OPENSEARCH_NODE || 'http://localhost:9200',
    auth: process.env.OPENSEARCH_AUTH ? {
      username: process.env.OPENSEARCH_USERNAME || 'admin',
      password: process.env.OPENSEARCH_PASSWORD || 'admin',
    } : undefined,
    indices: {
      activities: process.env.OPENSEARCH_INDEX_ACTIVITIES || 'activities',
    },
    // Bulk indexing settings
    bulk: {
      flushBytes: parseInt(process.env.OPENSEARCH_BULK_FLUSH_BYTES || '5000000', 10), // 5MB
      flushInterval: parseInt(process.env.OPENSEARCH_BULK_FLUSH_INTERVAL || '5000', 10), // 5s
    },
  },
  
  // Signing API configuration
  signingApi: {
    url: process.env.SIGNING_API_URL || 'http://localhost:3000/api/signature',
    timeout: parseInt(process.env.SIGNING_API_TIMEOUT || '5000', 10),
  },
  
  // Federation settings
  federation: {
    // Maximum concurrent deliveries per domain
    maxConcurrentPerDomain: parseInt(process.env.MAX_CONCURRENT_PER_DOMAIN || '5', 10),
    // Retry policy
    maxRetries: parseInt(process.env.MAX_RETRIES || '10', 10),
    // Initial retry delay in ms
    retryDelay: parseInt(process.env.RETRY_DELAY || '60000', 10),
    // Request timeout in ms
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '30000', 10),
  },
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

export default config;
