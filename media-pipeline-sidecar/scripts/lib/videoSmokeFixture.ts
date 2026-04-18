import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createStaticFixtureServer } from './staticFixtureServer';
import { getFfmpegPath } from '../../src/utils/videoTooling';

const execFileAsync = promisify(execFile);

export async function createVideoSmokeFixtureServer(): Promise<{
  scratchDir: string;
  mediaMock: Awaited<ReturnType<typeof createStaticFixtureServer>>;
}> {
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'media-pipeline-video-fixture-'));
  const fixturePath = path.join(scratchDir, 'fixture.mov');
  await buildFixtureVideo(fixturePath);
  const fixtureBytes = await readFile(fixturePath);
  const mediaMock = await createStaticFixtureServer({
    pathname: '/media/test-video.mov',
    contentType: 'video/quicktime',
    body: fixtureBytes
  });

  return {
    scratchDir,
    mediaMock
  };
}

async function buildFixtureVideo(outputPath: string): Promise<void> {
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary missing; cannot build video smoke fixture');
  }

  await execFileAsync(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=640x360:d=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath
  ]);
}
