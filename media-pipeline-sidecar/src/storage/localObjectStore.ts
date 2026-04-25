import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/config';
import { buildPutObjectPolicy } from './objectStorePolicy';
import type { LocalMediaObjectHandle, MediaObjectClass, MediaObjectMetadata } from './objectStoreTypes';

interface PersistedLocalObjectMetadata {
  key: string;
  contentType: string;
  cacheControl: string;
  contentDisposition: string;
  metadata: Record<string, string>;
}

interface LocalObjectPaths {
  key: string;
  objectPath: string;
  metadataPath: string;
}

export async function putLocalObject(
  key: string,
  contentType: string,
  bodyFactory: () => Buffer | Readable,
  objectClass: MediaObjectClass
): Promise<void> {
  const paths = resolveLocalObjectPaths(key);
  const policy = buildPutObjectPolicy(paths.key, contentType, objectClass);
  const objectDir = dirname(paths.objectPath);
  const metadataDir = dirname(paths.metadataPath);
  const tempObjectPath = join(objectDir, `${basename(paths.objectPath)}.${randomUUID()}.tmp`);

  await mkdir(objectDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });

  try {
    const body = bodyFactory();
    if (Buffer.isBuffer(body)) {
      await writeFile(tempObjectPath, body);
    } else {
      await pipeline(body, createWriteStream(tempObjectPath, { mode: 0o600 }));
    }

    await rename(tempObjectPath, paths.objectPath);
    await writeJsonAtomic(paths.metadataPath, {
      key: paths.key,
      contentType,
      cacheControl: policy.cacheControl,
      contentDisposition: policy.contentDisposition,
      metadata: policy.metadata
    });
  } catch (error) {
    await rm(tempObjectPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readLocalObject(key: string): Promise<Buffer> {
  const { objectPath } = resolveLocalObjectPaths(key);
  return readFile(objectPath);
}

export async function copyLocalObjectToPath(key: string, destinationPath: string): Promise<void> {
  const { objectPath } = resolveLocalObjectPaths(key);
  await copyFile(objectPath, destinationPath);
}

export async function deleteLocalObject(key: string): Promise<void> {
  const { objectPath, metadataPath } = resolveLocalObjectPaths(key);
  await Promise.all([
    rm(objectPath, { force: true }),
    rm(metadataPath, { force: true })
  ]);
}

export async function headLocalObject(key: string): Promise<MediaObjectMetadata> {
  try {
    const handle = await getLocalObjectHandle(key);
    if (!handle) {
      return { exists: false };
    }

    return {
      exists: true,
      contentLength: handle.contentLength,
      contentType: handle.contentType,
      cacheControl: handle.cacheControl,
      contentDisposition: handle.contentDisposition,
      metadata: handle.metadata
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false };
    }

    throw error;
  }
}

export async function getLocalObjectHandle(key: string): Promise<LocalMediaObjectHandle | null> {
  const paths = resolveLocalObjectPaths(key);
  try {
    const [fileStat, persistedMetadata] = await Promise.all([
      stat(paths.objectPath),
      readPersistedMetadata(paths.metadataPath)
    ]);

    return {
      exists: true,
      filePath: paths.objectPath,
      contentLength: fileStat.size,
      contentType: persistedMetadata?.contentType || 'application/octet-stream',
      cacheControl: persistedMetadata?.cacheControl,
      contentDisposition: persistedMetadata?.contentDisposition,
      metadata: persistedMetadata?.metadata,
      lastModified: fileStat.mtime,
      etag: buildWeakEtag(fileStat.size, fileStat.mtimeMs)
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function resolveLocalObjectPaths(rawKey: string): LocalObjectPaths {
  const key = normalizeObjectKey(rawKey);
  const segments = key.split('/');
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);
  const objectPath = join(config.mediaObjectRoot, 'objects', ...segments);
  const metadataPath = join(config.mediaObjectRoot, 'metadata', ...dirSegments, `${fileName}.meta.json`);

  return {
    key,
    objectPath,
    metadataPath
  };
}

function normalizeObjectKey(rawKey: string): string {
  const normalized = rawKey.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.trim().length === 0) {
    throw new Error('Object key must not be empty');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe object key: ${rawKey}`);
  }

  return segments.join('/');
}

async function readPersistedMetadata(metadataPath: string): Promise<PersistedLocalObjectMetadata | null> {
  try {
    const raw = await readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedLocalObjectMetadata>;
    if (
      typeof parsed.contentType !== 'string' ||
      typeof parsed.cacheControl !== 'string' ||
      typeof parsed.contentDisposition !== 'string' ||
      !parsed.metadata ||
      typeof parsed.metadata !== 'object' ||
      Array.isArray(parsed.metadata)
    ) {
      return null;
    }

    return {
      key: typeof parsed.key === 'string' ? parsed.key : '',
      contentType: parsed.contentType,
      cacheControl: parsed.cacheControl,
      contentDisposition: parsed.contentDisposition,
      metadata: Object.fromEntries(
        Object.entries(parsed.metadata).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function writeJsonAtomic(pathname: string, payload: PersistedLocalObjectMetadata): Promise<void> {
  const tempPath = `${pathname}.${randomUUID()}.tmp`;
  await mkdir(dirname(pathname), { recursive: true });

  try {
    await writeFile(tempPath, JSON.stringify(payload), { mode: 0o600 });
    await rename(tempPath, pathname);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buildWeakEtag(size: number, mtimeMs: number): string {
  return `W/\"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}\"`;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
  );
}
