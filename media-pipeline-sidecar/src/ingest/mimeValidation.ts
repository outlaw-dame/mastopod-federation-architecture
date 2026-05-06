import { fileTypeFromBuffer } from 'file-type';

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif'
]);

const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime'
]);

export interface ValidatedMedia {
  kind: 'image' | 'video' | 'animated-gif';
  mimeType: string;
  extension?: string;
}

function normalizeMimeType(input?: string): string | undefined {
  if (!input) return undefined;
  return input.split(';')[0]?.trim().toLowerCase() || undefined;
}

export async function validateMediaPayload(params: {
  buffer: Buffer;
  declaredMimeType?: string;
}): Promise<ValidatedMedia> {
  if (!params.buffer || params.buffer.byteLength === 0) {
    throw new Error('Media payload is empty');
  }

  const detected = await fileTypeFromBuffer(params.buffer);
  const detectedMime = normalizeMimeType(detected?.mime);
  const declaredMime = normalizeMimeType(params.declaredMimeType);
  const effectiveMime = detectedMime || declaredMime;

  if (!effectiveMime) {
    throw new Error('Unable to determine media type');
  }

  if (declaredMime && detectedMime && declaredMime !== detectedMime) {
    const sameFamily = declaredMime.split('/')[0] === detectedMime.split('/')[0];
    if (!sameFamily) {
      throw new Error(`Declared media type ${declaredMime} does not match detected media type ${detectedMime}`);
    }
  }

  if (ALLOWED_IMAGE_MIME.has(effectiveMime)) {
    // GIF: detect animation to route to the video worker (animated WebP conversion)
    if (effectiveMime === 'image/gif' && isAnimatedGif(params.buffer)) {
      return {
        kind: 'animated-gif',
        mimeType: effectiveMime,
        extension: detected?.ext
      };
    }
    return {
      kind: 'image',
      mimeType: effectiveMime,
      extension: detected?.ext
    };
  }

  if (ALLOWED_VIDEO_MIME.has(effectiveMime)) {
    return {
      kind: 'video',
      mimeType: effectiveMime,
      extension: detected?.ext
    };
  }

  throw new Error(`Unsupported media type: ${effectiveMime}`);
}

/**
 * Lightweight animated GIF detector.
 *
 * Parses GIF block structure from the sniff buffer and returns true when more
 * than one Image Descriptor (0x2C) is found, indicating multiple frames.
 *
 * Only GIF89a files can be animated. GIF87a is always treated as static.
 * If the buffer is truncated before the second frame header is reached (rare
 * for the default 8 KB sniff window), the file is conservatively treated as
 * static and processed by the image worker.
 */
function isAnimatedGif(buffer: Buffer): boolean {
  if (buffer.length < 13) return false;

  const sig = buffer.toString('ascii', 0, 6);
  if (sig !== 'GIF89a') return false; // GIF87a cannot carry animation

  // Logical Screen Descriptor starts at offset 6 (7 bytes total)
  const packed = buffer[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 3 * (2 ** ((packed & 0x07) + 1)) : 0;

  let offset = 13 + gctSize; // skip header + screen descriptor + GCT
  let frameCount = 0;

  while (offset < buffer.length) {
    const marker = buffer[offset];

    if (marker === 0x3b) break; // GIF Trailer

    if (marker === 0x2c) {
      // Image Descriptor (10 bytes: 1 introducer + 9 data bytes)
      frameCount++;
      if (frameCount > 1) return true;

      if (offset + 9 >= buffer.length) break;
      const localPacked = buffer[offset + 9];
      const hasLct = (localPacked & 0x80) !== 0;
      const lctSize = hasLct ? 3 * (2 ** ((localPacked & 0x07) + 1)) : 0;
      // Skip: Image Descriptor (10 bytes) + LCT + LZW minimum code size (1 byte)
      offset += 10 + lctSize + 1;
      // Skip image data sub-blocks
      offset = skipGifSubBlocks(buffer, offset);
      continue;
    }

    if (marker === 0x21) {
      // Extension block: skip 1 introducer + 1 label + sub-blocks
      if (offset + 1 >= buffer.length) break;
      offset += 2;
      offset = skipGifSubBlocks(buffer, offset);
      continue;
    }

    // Unknown marker — stop parsing conservatively
    break;
  }

  return frameCount > 1;
}

function skipGifSubBlocks(buffer: Buffer, offset: number): number {
  while (offset < buffer.length) {
    const blockSize = buffer[offset];
    if (blockSize === 0) return offset + 1; // block terminator
    offset += 1 + blockSize;
  }
  return offset;
}
