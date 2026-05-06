import { buildCanonicalMediaUrl } from './cdnUrlBuilder';
import { uploadFileToFilebase } from './filebaseClient';
import { config } from '../config/config';
import type { GeneratedVideoStreamingManifest, VideoRenditionResult } from '../processing/video';
import { uploadWithLimit } from '../utils/uploadPool';

export async function persistVideoRenditions(
  sha256: string,
  renditions: VideoRenditionResult
): Promise<{
  previewUrl?: string;
  thumbnailUrl?: string;
  playbackVariants: Array<{
    label: string;
    url: string;
    mimeType: string;
    width?: number;
    height?: number;
    bitrateKbps?: number;
  }>;
  streamingManifests: Array<{
    protocol: 'hls' | 'dash';
    url: string;
    mimeType: string;
    defaultVariantLabel?: string;
    variants: Array<{
      label: string;
      url: string;
      mimeType: string;
      width?: number;
      height?: number;
      bitrateKbps?: number;
    }>;
  }>;
}> {
  const preview = renditions.previewPath
    ? await uploadFileToFilebase({
        key: `${sha256}-preview.webp`,
        filePath: renditions.previewPath,
        contentType: 'image/webp',
        objectClass: 'image-preview'
      })
    : null;
  const thumbnail = renditions.thumbnailPath
    ? await uploadFileToFilebase({
        key: `${sha256}-thumb.webp`,
        filePath: renditions.thumbnailPath,
        contentType: 'image/webp',
        objectClass: 'image-thumbnail'
      })
    : null;

  const playbackVariants = await Promise.all((renditions.playbackVariants || []).map(async (variant) => {
    const uploaded = await uploadFileToFilebase({
      key: `${sha256}-${variant.label}.mp4`,
      filePath: variant.filePath,
      contentType: variant.mimeType,
      objectClass: 'video-playback'
    });

    return {
      label: variant.label,
      url: buildCanonicalMediaUrl(uploaded.key),
      mimeType: variant.mimeType,
      width: variant.width,
      height: variant.height,
      bitrateKbps: variant.bitrateKbps
    };
  }));

  const streamingManifests = await Promise.all((renditions.streamingManifests || []).map((manifest) => {
    return persistStreamingManifestSet(sha256, manifest);
  }));

  return {
    previewUrl: preview ? buildCanonicalMediaUrl(preview.key) : undefined,
    thumbnailUrl: thumbnail ? buildCanonicalMediaUrl(thumbnail.key) : undefined,
    playbackVariants,
    streamingManifests
  };
}

async function persistStreamingManifestSet(
  sha256: string,
  manifest: GeneratedVideoStreamingManifest
): Promise<{
  protocol: 'hls' | 'dash';
  url: string;
  mimeType: string;
  defaultVariantLabel?: string;
  variants: Array<{
    label: string;
    url: string;
    mimeType: string;
    width?: number;
    height?: number;
    bitrateKbps?: number;
  }>;
}> {
  const basePrefix = `${sha256}/${manifest.protocol}`;

  await uploadWithLimit(manifest.artifactFiles, config.mediaObjectUploadConcurrency, async (artifact) => {
    await uploadFileToFilebase({
      key: `${basePrefix}/${artifact.relativePath}`,
      filePath: artifact.filePath,
      contentType: artifact.contentType,
      objectClass: streamingObjectClassForArtifact(artifact.relativePath, artifact.contentType)
    });
  });

  return {
    protocol: manifest.protocol,
    url: buildCanonicalMediaUrl(`${basePrefix}/${manifest.relativePath}`),
    mimeType: manifest.mimeType,
    defaultVariantLabel: manifest.defaultVariantLabel,
    variants: manifest.variants.map((variant) => ({
      label: variant.label,
      url: buildCanonicalMediaUrl(`${basePrefix}/${variant.relativePath}`),
      mimeType: variant.mimeType,
      width: variant.width,
      height: variant.height,
      bitrateKbps: variant.bitrateKbps
    }))
  };
}

function streamingObjectClassForArtifact(
  relativePath: string,
  contentType: string
): 'streaming-manifest' | 'streaming-segment' {
  if (
    relativePath.endsWith('.m3u8')
    || relativePath.endsWith('.mpd')
    || contentType === 'application/vnd.apple.mpegurl'
    || contentType === 'application/dash+xml'
  ) {
    return 'streaming-manifest';
  }

  return 'streaming-segment';
}
