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
  kind: 'image' | 'video';
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
