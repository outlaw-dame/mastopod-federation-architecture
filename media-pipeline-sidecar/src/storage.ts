import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey
  }
});

export async function uploadObject(key: string, body: Uint8Array, contentType: string) {
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  }));

  return `${config.s3.endpoint}/${config.s3.bucket}/${key}`;
}
