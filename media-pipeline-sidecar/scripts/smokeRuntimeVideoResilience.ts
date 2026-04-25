#!/usr/bin/env tsx

import { rm } from 'node:fs/promises';
import { runSmokeHarness } from './lib/smokeHarness';
import { closeFixtureServer } from './lib/staticFixtureServer';
import { createVideoSmokeFixtureServer } from './lib/videoSmokeFixture';

async function main(): Promise<void> {
  let mediaMock: Awaited<ReturnType<typeof createVideoSmokeFixtureServer>>['mediaMock'] | undefined;
  let scratchDir: string | undefined;

  try {
    const fixture = await createVideoSmokeFixtureServer();
    mediaMock = fixture.mediaMock;
    scratchDir = fixture.scratchDir;

    const healthy = await runSmokeHarness({
      sourceUrl: mediaMock.url,
      runSsrfValidation: false,
      expectedKind: 'video',
      requestTimeoutMs: 15000,
      maxDownloadBytes: 10 * 1024 * 1024
    });

    const degraded = await runSmokeHarness({
      sourceUrl: mediaMock.url,
      runSsrfValidation: false,
      expectedKind: 'video',
      requestTimeoutMs: 15000,
      maxDownloadBytes: 10 * 1024 * 1024,
      envOverrides: {
        FFMPEG_PATH: '/nonexistent/ffmpeg',
        FFPROBE_PATH: '/nonexistent/ffprobe'
      }
    });

    if (healthy.playbackVariantCount < 1 || healthy.streamingManifestCount < 2) {
      throw new Error('Healthy video resilience smoke did not generate full renditions');
    }
    if (degraded.playbackVariantCount !== 0) {
      throw new Error(`Expected degraded video run to skip playback renditions, received ${degraded.playbackVariantCount}`);
    }
    if (degraded.streamingManifestCount !== 0) {
      throw new Error(`Expected degraded video run to skip streaming manifests, received ${degraded.streamingManifestCount}`);
    }
    if (degraded.projectedDeliveryKind !== 'original') {
      throw new Error(`Expected degraded ActivityPub projection to fall back to original delivery, received ${degraded.projectedDeliveryKind || 'unknown'}`);
    }
    if (!degraded.projectedMediaType?.startsWith('video/')) {
      throw new Error(`Expected degraded ActivityPub projection to preserve a video mime type, received ${degraded.projectedMediaType || 'unknown'}`);
    }

    console.log('smoke-runtime:video:resilience success');
    console.log(`healthyPlaybackVariantCount=${healthy.playbackVariantCount}`);
    console.log(`healthyStreamingManifestCount=${healthy.streamingManifestCount}`);
    console.log(`degradedPlaybackVariantCount=${degraded.playbackVariantCount}`);
    console.log(`degradedStreamingManifestCount=${degraded.streamingManifestCount}`);
    console.log(`degradedProjectedDeliveryKind=${degraded.projectedDeliveryKind || 'unknown'}`);
    console.log(`degradedProjectedMediaType=${degraded.projectedMediaType || 'unknown'}`);
  } finally {
    if (mediaMock) {
      await closeFixtureServer(mediaMock.server);
    }
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('smoke-runtime:video:resilience failed');
  console.error(err);
  process.exit(1);
});
