import { join } from 'node:path';

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

function parseNonEmptyString(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function parsePositiveIntList(value: string | undefined, fallback: number[]): number[] {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const parsed = value
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0);

  return parsed.length > 0 ? parsed : fallback;
}

type VideoDeliveryPreference = 'playback' | 'original' | 'stream:hls' | 'stream:dash';

function parseVideoDeliveryOrder(
  value: string | undefined,
  fallback: VideoDeliveryPreference[]
): VideoDeliveryPreference[] {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const allowed = new Set<VideoDeliveryPreference>(['playback', 'original', 'stream:hls', 'stream:dash']);
  const parsed = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase() as VideoDeliveryPreference)
    .filter((entry): entry is VideoDeliveryPreference => allowed.has(entry));

  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

function loadConfigFromEnv() {
  const port = parsePositiveInt(process.env.PORT, 8090);
  const mediaDataDir = process.env.MEDIA_DATA_DIR || './data';
  const mediaObjectStoreBackend = process.env.MEDIA_OBJECT_STORE_BACKEND === 'file' ? 'file' : 's3';
  const mediaObjectPublicBaseUrl = parseNonEmptyString(
    process.env.MEDIA_OBJECT_PUBLIC_BASE_URL,
    `http://localhost:${port}/media`
  );

  return {
    port,
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
    workerReadCount: parsePositiveInt(process.env.WORKER_READ_COUNT, 10),
    workerBlockMs: parsePositiveInt(process.env.WORKER_BLOCK_MS, 5000),
    workerMaxScheduledRetries: parsePositiveInt(process.env.WORKER_MAX_SCHEDULED_RETRIES, 4),
    workerRetryBaseDelayMs: parsePositiveInt(process.env.WORKER_RETRY_BASE_DELAY_MS, 1000),
    workerRetryMaxDelayMs: parsePositiveInt(process.env.WORKER_RETRY_MAX_DELAY_MS, 60000),
    imageMaxInputPixels: parsePositiveInt(process.env.IMAGE_MAX_INPUT_PIXELS, 40_000_000),
    mediaSniffBytes: parsePositiveInt(process.env.MEDIA_SNIFF_BYTES, 8192),
    maxSignalPayloadBytes: parsePositiveInt(process.env.MAX_SIGNAL_PAYLOAD_BYTES, 8192),
    dlqPayloadPreviewBytes: parsePositiveInt(process.env.DLQ_PAYLOAD_PREVIEW_BYTES, 1024),
    opensearchBulkIndexBatchSize: parsePositiveInt(process.env.OPENSEARCH_BULK_INDEX_BATCH_SIZE, 25),
    opensearchUrl: process.env.OPENSEARCH_URL || 'http://localhost:9200',
    mediaDataDir,
    mediaObjectStoreBackend,
    mediaObjectRoot: process.env.MEDIA_OBJECT_ROOT || join(mediaDataDir, 'object-store'),
    mediaObjectPublicBaseUrl,
    workerScratchDir: process.env.WORKER_SCRATCH_DIR || 'tmp',
    workerScratchMaxAgeMs: parsePositiveInt(process.env.WORKER_SCRATCH_MAX_AGE_MS, 6 * 60 * 60 * 1000),
    workerScratchCleanupIntervalMs: parsePositiveInt(process.env.WORKER_SCRATCH_CLEANUP_INTERVAL_MS, 10 * 60 * 1000),
    immutableAssetCacheControl: parseNonEmptyString(
      process.env.IMMUTABLE_ASSET_CACHE_CONTROL,
      'public, max-age=31536000, immutable'
    ),
    streamingManifestCacheControl: parseNonEmptyString(
      process.env.STREAMING_MANIFEST_CACHE_CONTROL,
      'public, max-age=60, s-maxage=300, stale-while-revalidate=60'
    ),
    transientObjectCacheControl: parseNonEmptyString(
      process.env.TRANSIENT_OBJECT_CACHE_CONTROL,
      'private, no-store, max-age=0'
    ),
    assetStoreBackend: process.env.ASSET_STORE_BACKEND === 'file' ? 'file' : 'redis',
    assetStoreRedisPrefix: process.env.ASSET_STORE_REDIS_PREFIX || 'media:assets',
    transientObjectPrefix: process.env.TRANSIENT_OBJECT_PREFIX || 'transient-media',
    videoRenditionTimeoutMs: parsePositiveInt(process.env.VIDEO_RENDITION_TIMEOUT_MS, 120000),
    videoPosterCaptureOffsetSeconds: parsePositiveInt(process.env.VIDEO_POSTER_CAPTURE_OFFSET_SECONDS, 1),
    videoPreviewWidth: parsePositiveInt(process.env.VIDEO_PREVIEW_WIDTH, 960),
    videoThumbnailWidth: parsePositiveInt(process.env.VIDEO_THUMBNAIL_WIDTH, 320),
    videoPlaybackRenditionWidths: parsePositiveIntList(process.env.VIDEO_PLAYBACK_RENDITION_WIDTHS, [480, 720]),
    videoPlaybackCrf: parsePositiveInt(process.env.VIDEO_PLAYBACK_CRF, 28),
    videoPlaybackAudioBitrateKbps: parsePositiveInt(process.env.VIDEO_PLAYBACK_AUDIO_BITRATE_KBPS, 96),
    videoPlaybackPreset: process.env.VIDEO_PLAYBACK_PRESET || 'veryfast',
    videoStreamSegmentDurationSeconds: parsePositiveInt(process.env.VIDEO_STREAM_SEGMENT_DURATION_SECONDS, 4),
    activityPubVideoDeliveryOrder: parseVideoDeliveryOrder(
      process.env.ACTIVITYPUB_VIDEO_DELIVERY_ORDER,
      ['playback', 'original', 'stream:hls', 'stream:dash']
    ),
    firstPartyVideoDeliveryOrder: parseVideoDeliveryOrder(
      process.env.FIRST_PARTY_VIDEO_DELIVERY_ORDER,
      ['stream:hls', 'stream:dash', 'playback', 'original']
    ),
    activityPodsMediaSourceBaseUrl: process.env.ACTIVITYPODS_MEDIA_SOURCE_BASE_URL || '',
    activityPodsMediaSourceToken: process.env.ACTIVITYPODS_MEDIA_SOURCE_TOKEN || '',
    activityPodsMediaSourcePath: parseNonEmptyString(
      process.env.ACTIVITYPODS_MEDIA_SOURCE_PATH,
      '/api/internal/media-pipeline/resolve-source'
    ),
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
}

export const config = loadConfigFromEnv();

export function reloadConfigFromEnv(): void {
  const next = loadConfigFromEnv();
  const nextS3 = next.s3;
  const nextRedpanda = next.redpanda;
  const currentS3 = config.s3;
  const currentRedpanda = config.redpanda;

  Object.assign(config, next);
  Object.assign(currentS3, nextS3);
  Object.assign(currentRedpanda, nextRedpanda);
  config.s3 = currentS3;
  config.redpanda = currentRedpanda;
}
