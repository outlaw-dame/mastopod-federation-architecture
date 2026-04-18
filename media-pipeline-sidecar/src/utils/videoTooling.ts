import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';

export function getFfmpegPath(): string | undefined {
  return process.env.FFMPEG_PATH || ffmpegPath || undefined;
}

export function getFfprobePath(): string | undefined {
  return process.env.FFPROBE_PATH || ffprobe.path || undefined;
}
