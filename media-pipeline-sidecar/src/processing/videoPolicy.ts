import { config } from '../config/config.js';

interface VideoPackagingRendition {
  name: string;
  height: number;
  bitrateKbps: number;
  audioBitrateKbps: number;
}

function renditionBitrateKbps(height: number): number {
  if (height >= 1080) return 5000;
  if (height >= 720) return 2800;
  if (height >= 480) return 1400;
  return 900;
}

export const DEFAULT_VIDEO_PACKAGING_POLICY: {
  encoderPreference: string;
  renditions: VideoPackagingRendition[];
} = {
  encoderPreference: 'libx264',
  renditions: config.videoPlaybackRenditionWidths.map((height) => ({
    name: `${height}p`,
    height,
    bitrateKbps: renditionBitrateKbps(height),
    audioBitrateKbps: config.videoPlaybackAudioBitrateKbps,
  })),
};
