import sharp from 'sharp';
import crypto from 'node:crypto';

export async function processImage(input: Uint8Array) {
  const image = sharp(input);
  const metadata = await image.metadata();

  const webp = await image.webp({ quality: 80 }).toBuffer();
  const thumb = await image.resize({ width: 320 }).webp().toBuffer();

  return {
    original: input,
    webp,
    thumb,
    width: metadata.width,
    height: metadata.height
  };
}

export function sha256(data: Uint8Array) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
