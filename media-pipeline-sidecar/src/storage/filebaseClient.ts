import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/config';
import { buildCanonicalMediaUrl } from './cdnUrlBuilder';
import { retryAsync } from '../utils/retry';
import { buildPutObjectPolicy } from './objectStorePolicy';
import {
  copyLocalObjectToPath,
  deleteLocalObject,
  headLocalObject,
  putLocalObject,
  readLocalObject
} from './localObjectStore';
import type { MediaObjectClass, MediaObjectMetadata } from './objectStoreTypes';

let client: S3Client | null = null;
let clientSignature = '';

export type FilebaseObjectClass = MediaObjectClass;
export type FilebaseObjectMetadata = MediaObjectMetadata;

function getClient(): S3Client {
  const nextSignature = JSON.stringify({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey
  });

  if (!client || clientSignature !== nextSignature) {
    client?.destroy();
    client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey
      }
    });
    clientSignature = nextSignature;
  }

  return client;
}

export async function uploadToFilebase(params: {
  key: string;
  body: Buffer;
  contentType: string;
  resolveCid?: boolean;
  objectClass?: FilebaseObjectClass;
}): Promise<{ key: string; cid?: string; url: string }> {
  const objectClass = params.objectClass || 'canonical-original';
  if (useLocalObjectStore()) {
    await putLocalObject(params.key, params.contentType, () => params.body, objectClass);
    return {
      key: params.key,
      url: buildCanonicalMediaUrl(params.key)
    };
  }

  await putObjectWithRetry(params.key, params.contentType, () => params.body, objectClass);

  const cid = params.resolveCid ? await resolveObjectCid(params.key) : undefined;

  return {
    key: params.key,
    cid,
    url: buildCanonicalMediaUrl(params.key)
  };
}

export async function uploadTransientToFilebase(params: {
  body?: Buffer;
  filePath?: string;
  contentType: string;
  traceId?: string;
}): Promise<{ key: string }> {
  if (!params.body && !params.filePath) {
    throw new Error('Transient upload requires either an in-memory body or a file path');
  }

  const key = `${config.transientObjectPrefix}/${params.traceId || randomUUID()}/${randomUUID()}`;
  if (useLocalObjectStore()) {
    await putLocalObject(key, params.contentType, () => {
      if (params.filePath) {
        return createReadStream(params.filePath);
      }

      return params.body as Buffer;
    }, 'transient');

    return { key };
  }

  await putObjectWithRetry(key, params.contentType, () => {
    if (params.filePath) {
      return createReadStream(params.filePath);
    }

    return params.body as Buffer;
  }, 'transient');

  return { key };
}

export async function downloadFromFilebase(key: string): Promise<Buffer> {
  if (useLocalObjectStore()) {
    return readLocalObject(key);
  }

  return retryAsync(async () => {
    const response = await getClient().send(new GetObjectCommand({
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

export async function uploadFileToFilebase(params: {
  key: string;
  filePath: string;
  contentType: string;
  resolveCid?: boolean;
  objectClass?: FilebaseObjectClass;
}): Promise<{ key: string; cid?: string; url: string }> {
  const objectClass = params.objectClass || 'canonical-original';
  if (useLocalObjectStore()) {
    await putLocalObject(
      params.key,
      params.contentType,
      () => createReadStream(params.filePath),
      objectClass
    );

    return {
      key: params.key,
      url: buildCanonicalMediaUrl(params.key)
    };
  }

  await putObjectWithRetry(
    params.key,
    params.contentType,
    () => createReadStream(params.filePath),
    objectClass
  );

  let cid: string | undefined;
  if (params.resolveCid) {
    cid = await resolveObjectCid(params.key);
  }

  return {
    key: params.key,
    cid,
    url: buildCanonicalMediaUrl(params.key)
  };
}

export async function downloadFromFilebaseToPath(key: string, destinationPath: string): Promise<void> {
  if (useLocalObjectStore()) {
    await copyLocalObjectToPath(key, destinationPath);
    return;
  }

  await retryAsync(async () => {
    const response = await getClient().send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }));

    if (!response.Body) {
      throw new Error(`Filebase object body missing for key: ${key}`);
    }

    await pipeline(bodyToReadable(response.Body), createWriteStream(destinationPath));
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });
}

export async function deleteFromFilebase(key: string): Promise<void> {
  if (useLocalObjectStore()) {
    await deleteLocalObject(key);
    return;
  }

  await retryAsync(async () => {
    await getClient().send(new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }));
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });
}

export async function headFilebaseObject(key: string): Promise<FilebaseObjectMetadata> {
  if (useLocalObjectStore()) {
    return headLocalObject(key);
  }

  try {
    const response = await retryAsync(async () => getClient().send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    })), {
      retries: 3,
      baseDelayMs: 400,
      maxDelayMs: 4000
    });

    return {
      exists: true,
      contentLength: typeof response.ContentLength === 'number' ? response.ContentLength : undefined,
      contentType: response.ContentType,
      cacheControl: response.CacheControl,
      contentDisposition: response.ContentDisposition,
      metadata: response.Metadata
    };
  } catch (error) {
    if (isMissingObjectError(error)) {
      return { exists: false };
    }

    throw error;
  }
}

async function putObjectWithRetry(
  key: string,
  contentType: string,
  bodyFactory: () => Buffer | Readable,
  objectClass: FilebaseObjectClass
): Promise<void> {
  const policy = buildPutObjectPolicy(key, contentType, objectClass);
  await retryAsync(async () => {
    await getClient().send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: bodyFactory(),
      ContentType: contentType,
      CacheControl: policy.cacheControl,
      ContentDisposition: policy.contentDisposition,
      Metadata: policy.metadata,
      Tagging: policy.tagging
    }));
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });
}

function useLocalObjectStore(): boolean {
  return config.mediaObjectStoreBackend === 'file';
}

async function resolveObjectCid(key: string): Promise<string | undefined> {
  try {
    const head = await getClient().send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }));
    const rawCid = head.Metadata?.cid;
    if (rawCid && rawCid.trim().length > 0) {
      return rawCid.trim();
    }
  } catch {
    // CID retrieval is best-effort; the rest of the pipeline continues without it
  }

  return undefined;
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

function bodyToReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body;
  }

  if (body && typeof body === 'object' && 'transformToWebStream' in body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function') {
    return Readable.fromWeb((body as { transformToWebStream(): unknown }).transformToWebStream() as never);
  }

  throw new Error('Unsupported S3 body type');
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  if (candidate.$metadata?.httpStatusCode === 404) {
    return true;
  }

  const code = typeof candidate.Code === 'string'
    ? candidate.Code
    : typeof candidate.code === 'string'
      ? candidate.code
      : '';

  return code === 'NotFound' || code === 'NoSuchKey';
}
