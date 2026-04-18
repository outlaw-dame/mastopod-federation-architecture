#!/usr/bin/env tsx

import { runSmokeHarness } from './lib/smokeHarness';
import { closeFixtureServer, createStaticFixtureServer } from './lib/staticFixtureServer';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64'
);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 1) {
    return values[0];
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

async function main(): Promise<void> {
  const runs = parsePositiveInt(process.env.SMOKE_PROFILE_RUNS, 3);
  const latencyMs = parsePositiveInt(process.env.SMOKE_PROFILE_FIXTURE_LATENCY_MS, 50);

  let mediaMock: Awaited<ReturnType<typeof createStaticFixtureServer>> | undefined;
  const durations: number[] = [];
  let lastAssetId = '';

  try {
    mediaMock = await createStaticFixtureServer({
      pathname: '/media/profile-image.png',
      contentType: 'image/png',
      body: pngBytes,
      latencyMs
    });

    for (let run = 0; run < runs; run += 1) {
      const startedAt = performance.now();
      const result = await runSmokeHarness({
        sourceUrl: mediaMock.url,
        runSsrfValidation: false,
        expectedKind: 'image'
      });
      durations.push(performance.now() - startedAt);
      lastAssetId = result.assetId;
    }

    console.log('smoke-runtime:profile success');
    console.log(`runs=${runs}`);
    console.log(`fixtureLatency=${latencyMs}ms`);
    console.log(`assetId=${lastAssetId}`);
    console.log(`min=${formatMs(Math.min(...durations))}`);
    console.log(`avg=${formatMs(average(durations))}`);
    console.log(`p50=${formatMs(percentile(durations, 0.5))}`);
    console.log(`p95=${formatMs(percentile(durations, 0.95))}`);
    console.log(`max=${formatMs(Math.max(...durations))}`);
  } finally {
    if (mediaMock) {
      await closeFixtureServer(mediaMock.server);
    }
  }
}

main().catch((err) => {
  console.error('smoke-runtime:profile failed');
  console.error(err);
  process.exit(1);
});
