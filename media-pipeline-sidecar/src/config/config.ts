function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

export const config = {
  port: parsePositiveInt(process.env.PORT, 8090),
  host: process.env.HOST || '0.0.0.0',
  token: process.env.INTERNAL_BEARER_TOKEN || '',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  maxDownloadBytes: parsePositiveInt(process.env.MAX_DOWNLOAD_BYTES, 52428800),
  requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 20000),
  ingressMaxBodyBytes: parsePositiveInt(process.env.INGRESS_MAX_BODY_BYTES, 16384),
  streamMaxLen: parsePositiveInt(process.env.STREAM_MAX_LEN, 10000),
  dlqMaxLen: parsePositiveInt(process.env.DLQ_MAX_LEN, 50000),
  pendingMinIdleMs: parsePositiveInt(process.env.PENDING_MIN_IDLE_MS, 60000),
  pendingClaimBatchSize: parsePositiveInt(process.env.PENDING_CLAIM_BATCH_SIZE, 50),
  opensearchUrl: process.env.OPENSEARCH_URL || 'http://localhost:9200',
  mediaDataDir: process.env.MEDIA_DATA_DIR || './data',
  assetStoreBackend: process.env.ASSET_STORE_BACKEND === 'file' ? 'file' : 'redis',
  assetStoreRedisPrefix: process.env.ASSET_STORE_REDIS_PREFIX || 'media:assets',
  transientObjectPrefix: process.env.TRANSIENT_OBJECT_PREFIX || 'transient-media',
  cloudflareMediaDomain: process.env.CLOUDFLARE_MEDIA_DOMAIN || '',
  ipfsGatewayBase: process.env.IPFS_GATEWAY_BASE || process.env.FILEBASE_GATEWAY_BASE || 'https://ipfs.filebase.io/ipfs',
  filebaseGatewayBase: process.env.FILEBASE_GATEWAY_BASE || 'https://ipfs.filebase.io/ipfs',
  safeBrowsingApiKey: process.env.SAFE_BROWSING_API_KEY || '',
  googleVisionApiKey: process.env.GOOGLE_VISION_API_KEY || '',
  googleVideoAccessToken: process.env.GOOGLE_VIDEO_ACCESS_TOKEN || '',
  s3: {
    endpoint: process.env.S3_ENDPOINT || 'https://s3.filebase.com',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || '',
    forcePathStyle: parseBoolean(process.env.S3_FORCE_PATH_STYLE, true)
  },
  redpanda: {
    brokers: (process.env.REDPANDA_BROKERS || '').split(',').filter(Boolean),
    enabled: process.env.ENABLE_EVENT_PUBLISH === 'true'
  }
};
