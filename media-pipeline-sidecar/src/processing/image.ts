import sharp from 'sharp';
import crypto from 'node:crypto';

export async function processImage(input: Buffer): Promise<{
  buffer: Buffer;
  width?: number;
  height?: number;
  thumbnail?: Buffer;
}> {
  const image = sharp(input);
  const metadata = await image.metadata();
  const buffer = await sharp(input).webp({ quality: 82 }).toBuffer();
  const thumbnail = await sharp(input).resize({ width: 320 }).webp({ quality: 70 }).toBuffer();

  return {
    buffer,
    width: metadata.width,
    height: metadata.height,
    thumbnail
  };
}

export function sha256(input: Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
