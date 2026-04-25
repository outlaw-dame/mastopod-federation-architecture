import sharp from 'sharp';
import crypto from 'node:crypto';
import { config } from '../config/config';

export async function processImage(input: Buffer): Promise<{
  buffer: Buffer;
  width?: number;
  height?: number;
  thumbnail?: Buffer;
}> {
  return processImageSource(input);
}

export async function processImageFile(inputPath: string): Promise<{
  buffer: Buffer;
  width?: number;
  height?: number;
  thumbnail?: Buffer;
}> {
  return processImageSource(inputPath);
}

async function processImageSource(input: Buffer | string): Promise<{
  buffer: Buffer;
  width?: number;
  height?: number;
  thumbnail?: Buffer;
}> {
  const pipeline = sharp(input, {
    limitInputPixels: config.imageMaxInputPixels,
    sequentialRead: true
  }).rotate();

  const [{ data, info }, thumbnail] = await Promise.all([
    pipeline.clone().webp({ quality: 82 }).toBuffer({ resolveWithObject: true }),
    pipeline.clone().resize({ width: 320, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer()
  ]);

  return {
    buffer: data,
    width: info.width,
    height: info.height,
    thumbnail
  };
}

export function sha256(input: Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
