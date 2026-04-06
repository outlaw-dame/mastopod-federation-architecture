export const config = {
  port: parseInt(process.env.PORT || '8090', 10),
  host: process.env.HOST || '0.0.0.0',
  token: process.env.INTERNAL_BEARER_TOKEN || '',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  maxDownloadBytes: parseInt(process.env.MAX_DOWNLOAD_BYTES || '52428800', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10),
  opensearchUrl: process.env.OPENSEARCH_URL || 'http://localhost:9200',
  mediaDataDir: process.env.MEDIA_DATA_DIR || './data',
  cloudflareMediaDomain: process.env.CLOUDFLARE_MEDIA_DOMAIN || '',
  filebaseGatewayBase: process.env.FILEBASE_GATEWAY_BASE || 'https://ipfs.filebase.io/ipfs',
  safeBrowsingApiKey: process.env.SAFE_BROWSING_API_KEY || '',
  googleVisionApiKey: process.env.GOOGLE_VISION_API_KEY || '',
  googleVideoAccessToken: process.env.GOOGLE_VIDEO_ACCESS_TOKEN || '',
  s3: {
    endpoint: process.env.S3_ENDPOINT || 'https://s3.filebase.com',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ''
  },
  redpanda: {
    brokers: (process.env.REDPANDA_BROKERS || '').split(',').filter(Boolean),
    enabled: process.env.ENABLE_EVENT_PUBLISH === 'true'
  }
};
