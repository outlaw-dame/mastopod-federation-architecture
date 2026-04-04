import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CanonicalAsset } from '../contracts/CanonicalAsset.js';

const DATA_DIR = process.env.MEDIA_DATA_DIR || './data';
const FILE = path.join(DATA_DIR, 'assets.json');

async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, JSON.stringify({ assets: [] }), 'utf-8');
  }
}

export async function saveAsset(asset: CanonicalAsset) {
  await ensureFile();
  const raw = await fs.readFile(FILE, 'utf-8');
  const data = JSON.parse(raw);

  const exists = data.assets.find((a: any) => a.hash === asset.hash);
  if (exists) return exists;

  data.assets.push(asset);
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
  return asset;
}

export async function getAsset(hash: string): Promise<CanonicalAsset | null> {
  await ensureFile();
  const raw = await fs.readFile(FILE, 'utf-8');
  const data = JSON.parse(raw);
  return data.assets.find((a: any) => a.hash === hash) || null;
}
