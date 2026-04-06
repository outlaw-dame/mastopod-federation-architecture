import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { config } from '../config/config';

const filePath = path.join(config.mediaDataDir, 'canonical-assets.json');

async function ensureStore(): Promise<void> {
  await fs.mkdir(config.mediaDataDir, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify({ assets: [] }, null, 2), 'utf-8');
  }
}

export async function saveAsset(asset: CanonicalAsset): Promise<CanonicalAsset> {
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
