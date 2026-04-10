import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { config } from '../config/config';
import { initRedis, redis } from '../queue/redisClient';

const filePath = path.join(config.mediaDataDir, 'canonical-assets.json');
const redisIndexKey = `${config.assetStoreRedisPrefix}:ids`;

async function ensureStore(): Promise<void> {
  await fs.mkdir(config.mediaDataDir, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify({ assets: [] }, null, 2), 'utf-8');
  }
}

export async function saveAsset(asset: CanonicalAsset): Promise<CanonicalAsset> {
  if (config.assetStoreBackend === 'redis') {
    await initRedis();
    const key = `${config.assetStoreRedisPrefix}:${asset.assetId}`;
    const payload = JSON.stringify(asset);
    const setResult = await redis.set(key, payload, { NX: true });
    if (setResult === 'OK') {
      await redis.sAdd(redisIndexKey, asset.assetId);
      return asset;
    }

    const existing = await redis.get(key);
    return existing ? JSON.parse(existing) as CanonicalAsset : asset;
  }

  await ensureStore();
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as { assets: CanonicalAsset[] };
  const exists = parsed.assets.find((item) => item.assetId === asset.assetId);
  if (!exists) {
    parsed.assets.push(asset);
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
  }
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
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as { assets: CanonicalAsset[] };
  return parsed.assets;
}
