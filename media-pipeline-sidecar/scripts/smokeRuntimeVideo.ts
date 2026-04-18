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

    const result = await runSmokeHarness({
      sourceUrl: mediaMock.url,
      runSsrfValidation: false,
      expectedKind: 'video',
      requestTimeoutMs: 15000,
      maxDownloadBytes: 10 * 1024 * 1024
    });

    console.log('smoke-runtime:video success');
    console.log(`assetId=${result.assetId}`);
    console.log(`mediaKind=${result.mediaKind}`);
    console.log(`playbackVariantCount=${result.playbackVariantCount}`);
    console.log(`streamingManifestCount=${result.streamingManifestCount}`);
    console.log(`streamingProtocols=${result.streamingProtocols.join(',')}`);
    console.log(`projectedDeliveryKind=${result.projectedDeliveryKind || 'unknown'}`);
    console.log(`projectedMediaType=${result.projectedMediaType || 'unknown'}`);
    console.log(`firstPartyProjectedDeliveryKind=${result.firstPartyProjectedDeliveryKind || 'unknown'}`);
    console.log(`firstPartyProjectedMediaType=${result.firstPartyProjectedMediaType || 'unknown'}`);
    if (result.playbackVariantCount < 1) {
      throw new Error('Video smoke fixture did not produce any playback renditions');
    }
    if (!result.streamingProtocols.includes('hls') || !result.streamingProtocols.includes('dash')) {
      throw new Error(`Expected both HLS and DASH streaming manifests, received ${result.streamingProtocols.join(',') || 'none'}`);
    }
    if (result.projectedDeliveryKind !== 'playback') {
      throw new Error(`Expected ActivityPub delivery kind to prefer playback, received ${result.projectedDeliveryKind || 'unknown'}`);
    }
    if (result.projectedMediaType !== 'video/mp4') {
      throw new Error(`Expected ActivityPub projected media type to be MP4, received ${result.projectedMediaType || 'unknown'}`);
    }
    if (result.firstPartyProjectedDeliveryKind !== 'streaming') {
      throw new Error(`Expected first-party delivery kind to prefer streaming, received ${result.firstPartyProjectedDeliveryKind || 'unknown'}`);
    }
    if (result.firstPartyProjectedMediaType !== 'application/vnd.apple.mpegurl') {
      throw new Error(`Expected first-party projected media type to be HLS, received ${result.firstPartyProjectedMediaType || 'unknown'}`);
    }
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
  console.error('smoke-runtime:video failed');
  console.error(err);
  process.exit(1);
});
