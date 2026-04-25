import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function getFfmpegPath(): string | undefined {
  return process.env.FFMPEG_PATH || ffmpegPath || undefined;
}

export function getFfprobePath(): string | undefined {
  return process.env.FFPROBE_PATH || ffprobe.path || undefined;
}

export async function assertVideoToolingReady(): Promise<void> {
  const ffmpegBinary = getFfmpegPath();
  const ffprobeBinary = getFfprobePath();

  if (!ffmpegBinary) {
    throw new Error('FFMPEG_PATH is not configured and ffmpeg-static is unavailable');
  }

  if (!ffprobeBinary) {
    throw new Error('FFPROBE_PATH is not configured and ffprobe-static is unavailable');
  }

  await Promise.all([
    assertExecutable(ffmpegBinary, 'ffmpeg'),
    assertExecutable(ffprobeBinary, 'ffprobe'),
  ]);
}

async function assertExecutable(binaryPath: string, label: string): Promise<void> {
  await access(binaryPath, constants.X_OK).catch(() => {
    throw new Error(`${label} binary is not executable: ${binaryPath}`);
  });

  await execFileAsync(binaryPath, ['-version'], { timeout: 5_000 }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} invocation failed: ${message}`);
  });
}
