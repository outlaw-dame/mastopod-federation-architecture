import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { config } from '../config/config';
import { initRedis, redis } from '../queue/redisClient';
import { mergePlaybackVariants, mergeStreamingManifests } from '../utils/playbackVariants';

const redisIndexKey = `${config.assetStoreRedisPrefix}:ids`;

function getFilePath(): string {
  return path.join(config.mediaDataDir, 'canonical-assets.json');
}

async function ensureStore(): Promise<void> {
  const filePath = getFilePath();
  await fs.mkdir(config.mediaDataDir, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify({ assets: [] }, null, 2), 'utf-8');
  }
}

function mergeOptionalString(primary?: string, secondary?: string): string | undefined {
  return primary || secondary || undefined;
}

function mergeOptionalNumber(primary?: number, secondary?: number): number | undefined {
  return typeof primary === 'number' ? primary : secondary;
}

function mergeCanonicalAsset(existing: CanonicalAsset, incoming: CanonicalAsset): CanonicalAsset {
  const firstSeenAt = existing.firstSeenAt || existing.createdAt || incoming.firstSeenAt || incoming.createdAt;
  const ownerIds = [...new Set([
    ...(Array.isArray(existing.ownerIds) ? existing.ownerIds : []),
    existing.ownerId,
    ...(Array.isArray(incoming.ownerIds) ? incoming.ownerIds : []),
    incoming.ownerId
  ].filter(Boolean))];
  const sourceUrls = [...new Set([
    ...(Array.isArray(existing.sourceUrls) ? existing.sourceUrls : []),
    ...(Array.isArray(incoming.sourceUrls) ? incoming.sourceUrls : []),
  ].filter(Boolean))];

  return {
    ...existing,
    ownerIds,
    sourceUrls: sourceUrls.length > 0 ? sourceUrls : undefined,
    cid: mergeOptionalString(existing.cid, incoming.cid),
    digestMultibase: mergeOptionalString(existing.digestMultibase, incoming.digestMultibase),
    duration: existing.duration ?? incoming.duration,
    width: mergeOptionalNumber(existing.width, incoming.width),
    height: mergeOptionalNumber(existing.height, incoming.height),
    focalPoint: existing.focalPoint ?? incoming.focalPoint,
    gatewayUrl: mergeOptionalString(existing.gatewayUrl, incoming.gatewayUrl),
    variants: {
      original: existing.variants.original || incoming.variants.original,
      preview: mergeOptionalString(existing.variants.preview, incoming.variants.preview),
      thumbnail: mergeOptionalString(existing.variants.thumbnail, incoming.variants.thumbnail),
      playback: mergePlaybackVariants(existing.variants.playback, incoming.variants.playback),
      streaming: mergeStreamingManifests(existing.variants.streaming, incoming.variants.streaming)
    },
    alt: mergeOptionalString(existing.alt, incoming.alt),
    blurhash: mergeOptionalString(existing.blurhash, incoming.blurhash),
    contentWarning: mergeOptionalString(existing.contentWarning, incoming.contentWarning),
    isSensitive: Boolean(existing.isSensitive || incoming.isSensitive),
    firstSeenAt,
    lastSeenAt: incoming.lastSeenAt || incoming.createdAt,
    ingestCount: (existing.ingestCount ?? 1) + 1
  };
}

async function saveRedisAsset(asset: CanonicalAsset): Promise<CanonicalAsset> {
  const key = `${config.assetStoreRedisPrefix}:${asset.assetId}`;
  const payload = JSON.stringify(asset);
  const setResult = await redis.set(key, payload, { NX: true });
  if (setResult === 'OK') {
    await redis.sAdd(redisIndexKey, asset.assetId);
    return asset;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await redis.watch(key);
    const existingRaw = await redis.get(key);
    if (!existingRaw) {
      await redis.unwatch();
      const retryResult = await redis.set(key, payload, { NX: true });
      if (retryResult === 'OK') {
        await redis.sAdd(redisIndexKey, asset.assetId);
        return asset;
      }
      continue;
    }

    const merged = mergeCanonicalAsset(JSON.parse(existingRaw) as CanonicalAsset, asset);
    const transaction = redis.multi();
    transaction.set(key, JSON.stringify(merged));
    transaction.sAdd(redisIndexKey, asset.assetId);
    const execResult = await transaction.exec();
    if (execResult !== null) {
      return merged;
    }
  }

  const existing = await redis.get(key);
  if (!existing) {
    return asset;
  }

  const merged = mergeCanonicalAsset(JSON.parse(existing) as CanonicalAsset, asset);
  await redis.set(key, JSON.stringify(merged));
  return merged;
}

async function replaceRedisAsset(asset: CanonicalAsset): Promise<CanonicalAsset> {
  const key = `${config.assetStoreRedisPrefix}:${asset.assetId}`;
  await redis.set(key, JSON.stringify(asset));
  await redis.sAdd(redisIndexKey, asset.assetId);
  return asset;
}

export async function saveAsset(asset: CanonicalAsset): Promise<CanonicalAsset> {
  if (config.assetStoreBackend === 'redis') {
    await initRedis();
    return saveRedisAsset(asset);
  }

  await ensureStore();
  const filePath = getFilePath();
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as { assets: CanonicalAsset[] };
  const exists = parsed.assets.find((item) => item.assetId === asset.assetId);
  if (!exists) {
    parsed.assets.push(asset);
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    return asset;
  }

  const merged = mergeCanonicalAsset(exists, asset);
  parsed.assets = parsed.assets.map((item) => item.assetId === asset.assetId ? merged : item);
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
  return merged;
}

export async function replaceAsset(asset: CanonicalAsset): Promise<CanonicalAsset> {
  if (config.assetStoreBackend === 'redis') {
    await initRedis();
    return replaceRedisAsset(asset);
  }

  await ensureStore();
  const filePath = getFilePath();
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as { assets: CanonicalAsset[] };
  const existingIndex = parsed.assets.findIndex((item) => item.assetId === asset.assetId);

  if (existingIndex === -1) {
    parsed.assets.push(asset);
  } else {
    parsed.assets[existingIndex] = asset;
  }

  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
  return asset;
}

export async function loadAllAssets(): Promise<CanonicalAsset[]> {
  if (config.assetStoreBackend === 'redis') {
    await initRedis();
    const ids = await redis.sMembers(redisIndexKey);
    if (ids.length === 0) {
      return [];
    }

    const keys = ids.map((id) => `${config.assetStoreRedisPrefix}:${id}`);
    const rows = await redis.mGet(keys);
    return rows.flatMap((row) => {
      if (!row) return [];
      return [JSON.parse(row) as CanonicalAsset];
    });
  }

  await ensureStore();
  const filePath = getFilePath();
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as { assets: CanonicalAsset[] };
  return parsed.assets;
}
