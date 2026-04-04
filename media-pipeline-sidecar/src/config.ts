export const config = {
  port: parseInt(process.env.PORT || '8090', 10),
  host: process.env.HOST || '0.0.0.0',
  token: process.env.INTERNAL_BEARER_TOKEN || '',
  maxDownloadBytes: parseInt(process.env.MAX_DOWNLOAD_BYTES || '52428800', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10),
  s3: {
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
  redpanda: {
    brokers: (process.env.REDPANDA_BROKERS || '').split(',').filter(Boolean),
    enabled: process.env.ENABLE_EVENT_PUBLISH === 'true'
  }
};
