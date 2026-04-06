import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config/config';
import { retryAsync } from '../utils/retry';

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey
  }
});

export async function uploadToFilebase(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ key: string; cid?: string; url: string }> {
  const response = await retryAsync(async () => {
    return client.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType
    }));
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });

  return {
    key: params.key,
    cid: response.$metadata?.httpHeaders?.['x-amz-meta-cid'],
    url: `${config.s3.endpoint.replace(/\/$/, '')}/${config.s3.bucket}/${params.key}`
  };
}
