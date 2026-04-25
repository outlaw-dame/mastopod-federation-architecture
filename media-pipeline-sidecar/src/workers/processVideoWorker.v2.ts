import { promises as fs } from 'node:fs';
import type { CanonicalAsset, VideoStreamingVariant } from '../contracts/CanonicalAsset.js';
import { generateDASH } from '../processing/dash.js';
import { probeVideo } from '../processing/ffprobe.js';
import { generateHLS } from '../processing/hls.js';
import { uploadWithLimit } from '../utils/uploadPool.js';
import { buildCdnUrl } from '../utils/cdnUrl.js';

interface ProcessVideoWorkerMessage {
  traceId: string;
  bytesBase64: string;
  ownerId: string;
  mimeType?: string;
  sourceUrl?: string;
  alt?: string;
  contentWarning?: string;
  isSensitive?: boolean | string;
}

interface UploadToFilebaseInput {
  key: string;
  body: Buffer;
  contentType: string;
}

interface ProcessVideoWorkerDeps {
  uploadToFilebase(input: UploadToFilebaseInput): Promise<unknown>;
  saveAsset(asset: CanonicalAsset): Promise<CanonicalAsset>;
  fileHash: string;
}

export async function processVideoWorker(
  message: ProcessVideoWorkerMessage,
  { uploadToFilebase, saveAsset, fileHash }: ProcessVideoWorkerDeps,
): Promise<CanonicalAsset> {
  const input = Buffer.from(message.bytesBase64, 'base64');
  const tmpPath = `/tmp/${message.traceId}.mp4`;

  await fs.writeFile(tmpPath, input);

  const meta = await probeVideo(tmpPath);
  if (meta.duration > 600) throw new Error('Video too long');

  const hls = await generateHLS(tmpPath);
  const dash = await generateDASH(tmpPath, hls.dir);

  const base = `video/${fileHash}`;
  const originalKey = `${base}/source.mp4`;
  const originalUrl = buildCdnUrl(originalKey);

  await uploadToFilebase({
    key: originalKey,
    body: input,
    contentType: message.mimeType || 'video/mp4'
  });

  await uploadToFilebase({
    key: `${base}/master.m3u8`,
    body: hls.master,
    contentType: 'application/vnd.apple.mpegurl'
  });

  await uploadWithLimit(hls.variants, 4, async (variant) => {
    await uploadToFilebase({
      key: `${base}/${variant.name}.m3u8`,
      body: variant.playlist,
      contentType: 'application/vnd.apple.mpegurl'
    });

    await uploadWithLimit(variant.segments, 4, async (segment) => {
      await uploadToFilebase({
        key: `${base}/${segment.name}`,
        body: segment.buffer,
        contentType: 'video/mp4'
      });
    });
  });

  await uploadToFilebase({
    key: `${base}/manifest.mpd`,
    body: await fs.readFile(dash),
    contentType: 'application/dash+xml'
  });

  const createdAt = new Date().toISOString();
  const streamingVariants: VideoStreamingVariant[] = hls.variants.map((variant) => ({
    label: variant.name,
    url: buildCdnUrl(`${base}/${variant.name}.m3u8`),
    mimeType: 'application/vnd.apple.mpegurl'
  }));

  const asset: CanonicalAsset = {
    assetId: fileHash,
    ownerId: message.ownerId,
    ownerIds: [message.ownerId],
    sha256: fileHash,
    mimeType: message.mimeType || 'video/mp4',
    size: input.length,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    canonicalUrl: originalUrl,
    sourceUrls: message.sourceUrl ? [message.sourceUrl] : undefined,
    variants: {
      original: originalUrl,
      streaming: [
        {
          protocol: 'hls',
          url: buildCdnUrl(`${base}/master.m3u8`),
          mimeType: 'application/vnd.apple.mpegurl',
          defaultVariantLabel: streamingVariants[0]?.label,
          variants: streamingVariants
        },
        {
          protocol: 'dash',
          url: buildCdnUrl(`${base}/manifest.mpd`),
          mimeType: 'application/dash+xml',
          variants: []
        }
      ]
    },
    alt: message.alt || undefined,
    contentWarning: message.contentWarning || undefined,
    isSensitive: message.isSensitive === true || message.isSensitive === 'true',
    createdAt,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    ingestCount: 1
  };

  return saveAsset(asset);
}
