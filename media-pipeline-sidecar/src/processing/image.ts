import sharp from 'sharp';
import crypto from 'node:crypto';
import { config } from '../config/config';

export interface ProcessedImage {
  buffer: Buffer;
  width?: number;
  height?: number;
  thumbnail?: Buffer;
  isAnimated: boolean;
  pageCount: number;
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  return processImageSource(input);
}

export async function processImageFile(inputPath: string): Promise<ProcessedImage> {
  return processImageSource(inputPath);
}

async function processImageSource(input: Buffer | string): Promise<ProcessedImage> {
  const metadata = await sharp(input, {
    limitInputPixels: config.imageMaxInputPixels,
    sequentialRead: true,
    animated: true
  }).metadata();
  const pageCount = Math.max(1, metadata.pages || 1);
  const isAnimated = pageCount > 1;

  const canonicalPipeline = sharp(input, {
    limitInputPixels: config.imageMaxInputPixels,
    sequentialRead: true,
    animated: isAnimated,
    pages: isAnimated ? -1 : 1
  }).rotate();

  const thumbnailPipeline = sharp(input, {
    limitInputPixels: config.imageMaxInputPixels,
    sequentialRead: true,
    pages: 1
  }).rotate();

  const [{ data, info }, thumbnail] = await Promise.all([
    canonicalPipeline.webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true }),
    thumbnailPipeline.resize({ width: 320, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer()
  ]);

  return {
    buffer: data,
    width: info.width,
    height: isAnimated ? metadata.pageHeight || info.height : info.height,
    thumbnail,
    isAnimated,
    pageCount
  };
}

export function sha256(input: Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
