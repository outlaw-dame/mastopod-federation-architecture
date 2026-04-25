import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFfmpegWithEncoderFallback } from './ffmpeg.js';
import { DEFAULT_VIDEO_PACKAGING_POLICY } from './videoPolicy.js';

interface HlsSegment {
  name: string;
  buffer: Buffer;
}

interface HlsVariant {
  name: string;
  playlist: Buffer;
  segments: HlsSegment[];
}

export async function generateHLS(
  inputPath: string,
): Promise<{ dir: string; master: Buffer; variants: HlsVariant[] }> {
  const dir = path.join(tmpdir(), `hls-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });

  const variants: HlsVariant[] = [];

  for (const rendition of DEFAULT_VIDEO_PACKAGING_POLICY.renditions) {
    const playlist = `${rendition.name}.m3u8`;

    await runFfmpegWithEncoderFallback({
      preferredEncoder: DEFAULT_VIDEO_PACKAGING_POLICY.encoderPreference,
      buildArgs: (encoder: string) => [
        '-y', '-i', inputPath,
        '-vf', `scale=-2:${rendition.height}`,
        '-c:v', encoder, '-b:v', `${rendition.bitrateKbps}k`, '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', `${rendition.audioBitrateKbps}k`,
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', `${rendition.name}_init.mp4`,
        '-hls_segment_filename', path.join(dir, `${rendition.name}_%03d.m4s`),
        path.join(dir, playlist),
      ],
    });

    const files = await fs.readdir(dir);
    const segments = await Promise.all(
      files
        .filter((fileName) => fileName.startsWith(rendition.name) && fileName.endsWith('.m4s'))
        .map(async (fileName) => ({
          name: fileName,
          buffer: await fs.readFile(path.join(dir, fileName)),
        })),
    );

    variants.push({
      name: rendition.name,
      playlist: await fs.readFile(path.join(dir, playlist)),
      segments,
    });
  }

  const master = variants
    .map((variant) => `#EXT-X-STREAM-INF:BANDWIDTH=2000000\n${variant.name}.m3u8`)
    .join('\n');

  await fs.writeFile(path.join(dir, 'master.m3u8'), master);

  return {
    dir,
    master: await fs.readFile(path.join(dir, 'master.m3u8')),
    variants,
  };
}
