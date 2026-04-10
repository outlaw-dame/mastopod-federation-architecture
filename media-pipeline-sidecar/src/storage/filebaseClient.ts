import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from '../config/config';
import { buildCanonicalMediaUrl } from './cdnUrlBuilder';
import { retryAsync } from '../utils/retry';

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
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
  await retryAsync(async () => {
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

  // Retrieve IPFS CID from Filebase object metadata (best-effort; may be absent for non-IPFS buckets)
  let cid: string | undefined;
  try {
    const head = await client.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: params.key
    }));
    const rawCid = head.Metadata?.cid;
    if (rawCid && rawCid.trim().length > 0) {
      cid = rawCid.trim();
    }
  } catch {
    // CID retrieval is best-effort; the rest of the pipeline continues without it
  }

  return {
    key: params.key,
    cid,
    url: buildCanonicalMediaUrl(params.key)
  };
}

export async function uploadTransientToFilebase(params: {
  body: Buffer;
  contentType: string;
  traceId?: string;
}): Promise<{ key: string }> {
  const key = `${config.transientObjectPrefix}/${params.traceId || randomUUID()}/${randomUUID()}`;
  await retryAsync(async () => {
    await client.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: params.body,
      ContentType: params.contentType
    }));
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });

  return { key };
}

export async function downloadFromFilebase(key: string): Promise<Buffer> {
  return retryAsync(async () => {
    const response = await client.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }));

    if (!response.Body) {
      throw new Error(`Filebase object body missing for key: ${key}`);
    }

    return readBodyAsBuffer(response.Body);
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });
}

export async function deleteFromFilebase(key: string): Promise<void> {
  await retryAsync(async () => {
    await client.send(new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }));
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });
}

async function readBodyAsBuffer(body: unknown): Promise<Buffer> {
  if (body && typeof body === 'object' && 'transformToByteArray' in body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error('Unsupported S3 body type');
}
