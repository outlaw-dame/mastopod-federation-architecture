import path from 'node:path';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { VideoPlaybackVariant, VideoStreamingManifest, VideoStreamingVariant } from '../contracts/CanonicalAsset';
import { config } from '../config/config';
import { logger } from '../logger';
import { NonRetryableMediaPipelineError } from '../utils/errorHandling';
import { sha256File } from '../utils/digest';
import { assertVideoToolingReady, getFfmpegPath, getFfprobePath } from '../utils/videoTooling';

const execFileAsync = promisify(execFile);

const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime'
]);

export interface VideoProcessingResult {
  mimeType: string;
  size: number;
  sha256: string;
}

export interface VideoRenditionResult {
  duration?: string;
  width?: number;
  height?: number;
  previewPath?: string;
  thumbnailPath?: string;
  playbackVariants?: GeneratedVideoPlaybackVariant[];
  streamingManifests?: GeneratedVideoStreamingManifest[];
}

export interface GeneratedVideoPlaybackVariant extends VideoPlaybackVariant {
  filePath: string;
}

export interface GeneratedVideoStreamingArtifact {
  relativePath: string;
  filePath: string;
  contentType: string;
}

export interface GeneratedVideoStreamingVariant extends Omit<VideoStreamingVariant, 'url'> {
  filePath: string;
  relativePath: string;
}

export interface GeneratedVideoStreamingManifest extends Omit<VideoStreamingManifest, 'url' | 'variants'> {
  filePath: string;
  relativePath: string;
  variants: GeneratedVideoStreamingVariant[];
  artifactFiles: GeneratedVideoStreamingArtifact[];
}

interface StreamingSource {
  label: string;
  filePath: string;
  width?: number;
  height?: number;
  bitrateKbps?: number;
}

export async function processVideoFile(inputPath: string, mimeType: string): Promise<VideoProcessingResult> {
  ensureSupportedVideoMimeType(mimeType);

  const metadata = await stat(inputPath);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new NonRetryableMediaPipelineError({
      code: 'VIDEO_PAYLOAD_EMPTY',
      message: 'Missing video payload for processing'
    });
  }

  return {
    mimeType,
    size: metadata.size,
    sha256: await sha256File(inputPath)
  };
}

export async function renderVideoRenditions(
  inputPath: string,
  outputDir: string,
  sourceMimeType?: string
): Promise<VideoRenditionResult> {
  await assertVideoToolingReady();

  const probed = await probeVideoMetadata(inputPath);
  const result: VideoRenditionResult = {
    duration: typeof probed.duration === 'number' && Number.isFinite(probed.duration)
      ? String(probed.duration)
      : undefined,
    width: probed.width,
    height: probed.height
  };

  const ffmpegBinary = getFfmpegPath()!;

  const posterSourcePath = path.join(outputDir, 'video-poster.png');
  const seekOffsetSeconds = normalizePosterOffsetSeconds(probed.duration);

  await execFileAsync(ffmpegBinary, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(seekOffsetSeconds),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    posterSourcePath
  ], {
    timeout: config.videoRenditionTimeoutMs
  });

  const previewPath = path.join(outputDir, 'video-preview.webp');
  const thumbnailPath = path.join(outputDir, 'video-thumb.webp');

  await Promise.all([
    sharp(posterSourcePath)
      .resize({ width: config.videoPreviewWidth, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(previewPath),
    sharp(posterSourcePath)
      .resize({ width: config.videoThumbnailWidth, withoutEnlargement: true })
      .webp({ quality: 70 })
      .toFile(thumbnailPath)
  ]);

  result.previewPath = previewPath;
  result.thumbnailPath = thumbnailPath;
  const playbackVariants = await transcodePlaybackVariants({
    inputPath,
    outputDir,
    sourceMimeType,
    sourceWidth: probed.width
  });
  result.playbackVariants = playbackVariants;
  result.streamingManifests = await renderStreamingManifests({
    inputPath,
    outputDir,
    sourceMimeType,
    sourceWidth: probed.width,
    sourceHeight: probed.height,
    playbackVariants
  });
  return result;
}

export function videoExtensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
    default:
      return 'mp4';
  }
}

function ensureSupportedVideoMimeType(mimeType: string): void {
  if (!SUPPORTED_VIDEO_MIME_TYPES.has(mimeType)) {
    throw new NonRetryableMediaPipelineError({
      code: 'VIDEO_MIME_UNSUPPORTED',
      message: `Unsupported video mime type: ${mimeType}`
    });
  }
}

function normalizePosterOffsetSeconds(durationSeconds?: number): number {
  const configured = config.videoPosterCaptureOffsetSeconds;
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return configured;
  }

  return Math.max(0, Math.min(configured, Math.floor(durationSeconds / 3)));
}

async function probeVideoMetadata(
  inputPath: string
): Promise<{ duration?: number; width?: number; height?: number; bitrateKbps?: number }> {
  const ffprobeBinary = getFfprobePath();
  if (!ffprobeBinary) {
    throw new NonRetryableMediaPipelineError({
      code: 'VIDEO_TOOLING_UNAVAILABLE',
      message: 'ffprobe is required for video metadata extraction'
    });
  }

  const { stdout } = await execFileAsync(ffprobeBinary, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration,bit_rate',
    '-of',
    'json',
    inputPath
  ], {
    timeout: config.videoRenditionTimeoutMs
  });

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string; bit_rate?: string };
  };

  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined;
  const duration = parsed.format?.duration ? Number(parsed.format.duration) : undefined;
  const bitrate = parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : undefined;
  const width = typeof stream?.width === 'number' ? stream.width : undefined;
  const height = typeof stream?.height === 'number' ? stream.height : undefined;

  return {
    duration: Number.isFinite(duration) ? duration : undefined,
    width,
    height,
    bitrateKbps: typeof bitrate === 'number' && Number.isFinite(bitrate)
      ? Math.round(bitrate / 1000)
      : undefined
  };
}

async function transcodePlaybackVariants(options: {
  inputPath: string;
  outputDir: string;
  sourceMimeType?: string;
  sourceWidth?: number;
}): Promise<GeneratedVideoPlaybackVariant[]> {
  const ffmpegBinary = getFfmpegPath();
  if (!ffmpegBinary) {
    throw new NonRetryableMediaPipelineError({
      code: 'VIDEO_TOOLING_UNAVAILABLE',
      message: 'ffmpeg is required for video playback renditions'
    });
  }

  const candidateWidths = buildPlaybackCandidateWidths(options.sourceMimeType, options.sourceWidth);
  const playbackVariants: GeneratedVideoPlaybackVariant[] = [];

  for (const targetWidth of candidateWidths) {
    const outputPath = path.join(options.outputDir, `video-playback-${targetWidth}.mp4`);
    const filter = `scale=w=min(${targetWidth}\\,iw):h=-2:force_original_aspect_ratio=decrease`;
    const bitrateKbps = playbackBitrateKbps(targetWidth);

    try {
      await execFileAsync(ffmpegBinary, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        options.inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        config.videoPlaybackPreset,
        '-crf',
        String(config.videoPlaybackCrf),
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-vf',
        filter,
        '-c:a',
        'aac',
        '-b:a',
        `${config.videoPlaybackAudioBitrateKbps}k`,
        '-maxrate',
        `${bitrateKbps}k`,
        '-bufsize',
        `${bitrateKbps * 2}k`,
        outputPath
      ], {
        timeout: config.videoRenditionTimeoutMs
      });

      const metadata = await probeVideoMetadata(outputPath);
      playbackVariants.push({
        label: `mp4-${metadata.width || targetWidth}w`,
        url: '',
        filePath: outputPath,
        mimeType: 'video/mp4',
        width: metadata.width,
        height: metadata.height,
        bitrateKbps: metadata.bitrateKbps
      });
    } catch (error) {
      logger.warn({
        targetWidth,
        sourceMimeType: options.sourceMimeType || null,
        error: error instanceof Error ? error.message : String(error)
      }, 'video-playback-variant-transcode-failed');
    }
  }

  return playbackVariants;
}

function buildPlaybackCandidateWidths(sourceMimeType: string | undefined, sourceWidth: number | undefined): number[] {
  const configuredWidths = [...new Set(config.videoPlaybackRenditionWidths)]
    .filter((width) => width > 0)
    .sort((left, right) => left - right);

  if (configuredWidths.length === 0) {
    return [];
  }

  const boundedWidths = typeof sourceWidth === 'number'
    ? configuredWidths.filter((width) => width < sourceWidth)
    : configuredWidths;

  if (boundedWidths.length > 0) {
    return boundedWidths;
  }

  if (sourceMimeType && sourceMimeType !== 'video/mp4') {
    if (typeof sourceWidth === 'number' && sourceWidth > 0) {
      return [normalizePlaybackWidth(sourceWidth)];
    }

    return [configuredWidths[0]];
  }

  return [];
}

function normalizePlaybackWidth(width: number): number {
  const rounded = Math.max(2, Math.floor(width));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function playbackBitrateKbps(width: number): number {
  if (width <= 480) {
    return 900;
  }

  if (width <= 720) {
    return 1800;
  }

  return 3000;
}

async function renderStreamingManifests(options: {
  inputPath: string;
  outputDir: string;
  sourceMimeType?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  playbackVariants: GeneratedVideoPlaybackVariant[];
}): Promise<GeneratedVideoStreamingManifest[]> {
  const sources = buildStreamingSources(options);
  if (sources.length === 0) {
    return [];
  }

  const manifests: GeneratedVideoStreamingManifest[] = [];
  const hlsManifest = await renderHlsManifest(options.outputDir, sources);
  if (hlsManifest) {
    manifests.push(hlsManifest);
  }

  const dashManifest = await renderDashManifest(options.outputDir, sources);
  if (dashManifest) {
    manifests.push(dashManifest);
  }

  return manifests;
}

function buildStreamingSources(options: {
  inputPath: string;
  sourceMimeType?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  playbackVariants: GeneratedVideoPlaybackVariant[];
}): StreamingSource[] {
  if (options.playbackVariants.length > 0) {
    return options.playbackVariants.map((variant) => ({
      label: variant.label,
      filePath: variant.filePath,
      width: variant.width,
      height: variant.height,
      bitrateKbps: variant.bitrateKbps
    }));
  }

  if (options.sourceMimeType === 'video/mp4') {
    return [{
      label: `source-${normalizePlaybackWidth(options.sourceWidth || 720)}w`,
      filePath: options.inputPath,
      width: options.sourceWidth,
      height: options.sourceHeight,
      bitrateKbps: typeof options.sourceWidth === 'number'
        ? playbackBitrateKbps(options.sourceWidth)
        : undefined
    }];
  }

  return [];
}

async function renderHlsManifest(
  outputDir: string,
  sources: StreamingSource[]
): Promise<GeneratedVideoStreamingManifest | undefined> {
  const ffmpegBinary = getFfmpegPath();
  if (!ffmpegBinary) {
    throw new NonRetryableMediaPipelineError({
      code: 'VIDEO_TOOLING_UNAVAILABLE',
      message: 'ffmpeg is required for HLS manifest generation'
    });
  }

  const hlsRootDir = path.join(outputDir, 'hls');
  await mkdir(hlsRootDir, { recursive: true });

  const variants: GeneratedVideoStreamingVariant[] = [];
  const artifactFiles: GeneratedVideoStreamingArtifact[] = [];

  for (const source of sources) {
    const slug = toVariantSlug(source.label);
    const variantDir = path.join(hlsRootDir, slug);
    await mkdir(variantDir, { recursive: true });

    const playlistPath = path.join(variantDir, 'playlist.m3u8');
    const playlistRelativePath = path.posix.join(slug, 'playlist.m3u8');
    const segmentPattern = path.join(variantDir, 'segment-%03d.ts');

    try {
      await execFileAsync(ffmpegBinary, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        source.filePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        config.videoPlaybackPreset,
        '-crf',
        String(config.videoPlaybackCrf),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        `${config.videoPlaybackAudioBitrateKbps}k`,
        '-maxrate',
        `${source.bitrateKbps || playbackBitrateKbps(source.width || 720)}k`,
        '-bufsize',
        `${(source.bitrateKbps || playbackBitrateKbps(source.width || 720)) * 2}k`,
        '-f',
        'hls',
        '-hls_time',
        String(config.videoStreamSegmentDurationSeconds),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_filename',
        segmentPattern,
        playlistPath
      ], {
        timeout: config.videoRenditionTimeoutMs
      });

      variants.push({
        label: source.label,
        filePath: playlistPath,
        relativePath: playlistRelativePath,
        mimeType: 'application/vnd.apple.mpegurl',
        width: source.width,
        height: source.height,
        bitrateKbps: source.bitrateKbps
      });

      const variantArtifacts = await collectStreamingArtifacts(variantDir, hlsRootDir, contentTypeForStreamingArtifact);
      artifactFiles.push(...variantArtifacts);
    } catch (error) {
      logger.warn({
        label: source.label,
        error: error instanceof Error ? error.message : String(error)
      }, 'video-streaming-hls-variant-render-failed');
    }
  }

  if (variants.length === 0) {
    return undefined;
  }

  const sortedVariants = sortStreamingVariants(variants);
  const defaultVariant = sortedVariants[sortedVariants.length - 1];
  const masterManifestPath = path.join(hlsRootDir, 'master.m3u8');
  const masterManifestRelativePath = 'master.m3u8';
  await writeFile(masterManifestPath, buildHlsMasterManifest(sortedVariants), 'utf-8');
  artifactFiles.push({
    relativePath: masterManifestRelativePath,
    filePath: masterManifestPath,
    contentType: 'application/vnd.apple.mpegurl'
  });

  return {
    protocol: 'hls',
    mimeType: 'application/vnd.apple.mpegurl',
    filePath: masterManifestPath,
    relativePath: masterManifestRelativePath,
    defaultVariantLabel: defaultVariant.label,
    variants: sortedVariants,
    artifactFiles
  };
}

async function renderDashManifest(
  outputDir: string,
  sources: StreamingSource[]
): Promise<GeneratedVideoStreamingManifest | undefined> {
  const ffmpegBinary = getFfmpegPath();
  if (!ffmpegBinary) {
    throw new NonRetryableMediaPipelineError({
      code: 'VIDEO_TOOLING_UNAVAILABLE',
      message: 'ffmpeg is required for DASH manifest generation'
    });
  }

  if (sources.length === 0) {
    return undefined;
  }

  const dashRootDir = path.join(outputDir, 'dash');
  await mkdir(dashRootDir, { recursive: true });

  const sortedSources = sortStreamingVariants(sources);
  const defaultSource = sortedSources[sortedSources.length - 1];
  const manifestPath = path.join(dashRootDir, 'stream.mpd');
  const manifestRelativePath = 'stream.mpd';

  try {
    await execFileAsync(ffmpegBinary, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      defaultSource.filePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      config.videoPlaybackPreset,
      '-crf',
      String(config.videoPlaybackCrf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      `${config.videoPlaybackAudioBitrateKbps}k`,
      '-seg_duration',
      String(config.videoStreamSegmentDurationSeconds),
      '-use_template',
      '1',
      '-use_timeline',
      '1',
      '-init_seg_name',
      'init-$RepresentationID$.m4s',
      '-media_seg_name',
      'chunk-$RepresentationID$-$Number%05d$.m4s',
      '-f',
      'dash',
      manifestPath
    ], {
      timeout: config.videoRenditionTimeoutMs
    });
  } catch (error) {
    logger.warn({
      label: defaultSource.label,
      error: error instanceof Error ? error.message : String(error)
    }, 'video-streaming-dash-render-failed');
    return undefined;
  }

  const artifactFiles = await collectStreamingArtifacts(dashRootDir, dashRootDir, contentTypeForDashArtifact);
  return {
    protocol: 'dash',
    mimeType: 'application/dash+xml',
    filePath: manifestPath,
    relativePath: manifestRelativePath,
    defaultVariantLabel: defaultSource.label,
    variants: [{
      label: defaultSource.label,
      filePath: manifestPath,
      relativePath: manifestRelativePath,
      mimeType: 'application/dash+xml',
      width: defaultSource.width,
      height: defaultSource.height,
      bitrateKbps: defaultSource.bitrateKbps
    }],
    artifactFiles
  };
}

function buildHlsMasterManifest(variants: GeneratedVideoStreamingVariant[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

  for (const variant of variants) {
    const bandwidthKbps = variant.bitrateKbps || playbackBitrateKbps(variant.width || 720);
    const attributes = [`BANDWIDTH=${bandwidthKbps * 1000}`, `AVERAGE-BANDWIDTH=${bandwidthKbps * 1000}`];
    if (variant.width && variant.height) {
      attributes.push(`RESOLUTION=${variant.width}x${variant.height}`);
    }

    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`);
    lines.push(variant.relativePath);
  }

  return `${lines.join('\n')}\n`;
}

async function collectStreamingArtifacts(
  rootDir: string,
  baseDir: string,
  contentTypeResolver: (fileName: string) => string
): Promise<GeneratedVideoStreamingArtifact[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const artifacts: GeneratedVideoStreamingArtifact[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...await collectStreamingArtifacts(entryPath, baseDir, contentTypeResolver));
      continue;
    }

    const relativePath = path.relative(baseDir, entryPath).split(path.sep).join(path.posix.sep);
    artifacts.push({
      relativePath,
      filePath: entryPath,
      contentType: contentTypeResolver(entry.name)
    });
  }

  return artifacts;
}

function contentTypeForStreamingArtifact(fileName: string): string {
  if (fileName.endsWith('.m3u8')) {
    return 'application/vnd.apple.mpegurl';
  }

  return 'video/mp2t';
}

function contentTypeForDashArtifact(fileName: string): string {
  if (fileName.endsWith('.mpd')) {
    return 'application/dash+xml';
  }

  if (fileName.endsWith('.m4s')) {
    return 'video/iso.segment';
  }

  return 'application/octet-stream';
}

function sortStreamingVariants<T extends { label: string; width?: number }>(variants: T[]): T[] {
  return [...variants].sort((left, right) => {
    const leftWidth = left.width ?? Number.MAX_SAFE_INTEGER;
    const rightWidth = right.width ?? Number.MAX_SAFE_INTEGER;
    return leftWidth - rightWidth || left.label.localeCompare(right.label);
  });
}

function toVariantSlug(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'variant';
}
