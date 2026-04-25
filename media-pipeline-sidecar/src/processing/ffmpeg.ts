import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfmpegPath } from '../utils/videoTooling.js';

const execFileAsync = promisify(execFile);

interface EncoderFallbackOptions {
  preferredEncoder: string;
  buildArgs: (encoder: string) => string[];
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpegBinary = getFfmpegPath() || 'ffmpeg';
  await execFileAsync(ffmpegBinary, args, {
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function runFfmpegWithEncoderFallback(
  options: EncoderFallbackOptions,
): Promise<void> {
  const candidates = [
    options.preferredEncoder,
    'libx264',
    'h264',
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  let lastError: unknown;
  for (const encoder of candidates) {
    try {
      await runFfmpeg(options.buildArgs(encoder));
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
