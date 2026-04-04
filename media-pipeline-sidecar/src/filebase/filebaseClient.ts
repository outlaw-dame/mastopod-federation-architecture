import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.js';

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey
  }
});

export interface FilebaseStoredObject {
  key: string;
  url: string;
  cid?: string;
  etag?: string;
}

export async function putObjectToFilebase(params: {
  key: string;
  body: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}): Promise<FilebaseStoredObject> {
  const command = new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
    Metadata: params.metadata
  });

  command.middlewareStack.add(
    (next) => async (args) => {
      const response = await next(args);
      return response;
    },
    { step: 'build', name: 'filebaseCidCapturePassThrough' }
  );

  const response = await client.send(command);

  const cid = response.$metadata?.httpHeaders?.['x-amz-meta-cid'];

  return {
    key: params.key,
    url: `${config.s3.endpoint}/${config.s3.bucket}/${params.key}`,
    cid,
    etag: response.ETag
  };
}

export async function headFilebaseObject(key: string): Promise<FilebaseStoredObject> {
  const response = await client.send(new HeadObjectCommand({
    Bucket: config.s3.bucket,
    Key: key
  }));

  return {
    key,
    url: `${config.s3.endpoint}/${config.s3.bucket}/${key}`,
    cid: response.Metadata?.cid || response.$metadata?.httpHeaders?.['x-amz-meta-cid'],
    etag: response.ETag
  };
}
