import { expectedKindFromEnv, runSmokeHarness } from './lib/smokeHarness';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('Expected a positive integer value for numeric smoke environment settings');
  }
  return Math.floor(num);
}

async function main(): Promise<void> {
  const sourceUrl = process.env.SMOKE_PUBLIC_FIXTURE_URL;
  if (!sourceUrl) {
    throw new Error('SMOKE_PUBLIC_FIXTURE_URL is required for smoke:runtime:public');
  }

  const result = await runSmokeHarness({
    sourceUrl,
    runSsrfValidation: true,
    expectedKind: expectedKindFromEnv(process.env.SMOKE_PUBLIC_EXPECT_KIND),
    requestTimeoutMs: parsePositiveInt(process.env.SMOKE_REQUEST_TIMEOUT_MS, 8000),
    maxDownloadBytes: parsePositiveInt(process.env.SMOKE_MAX_DOWNLOAD_BYTES, 10 * 1024 * 1024)
  });

  console.log('smoke-runtime:public success');
  console.log(`assetId=${result.assetId}`);
  console.log(`mediaKind=${result.mediaKind}`);
}

main().catch((err) => {
  console.error('smoke-runtime:public failed');
  console.error(err);
  process.exit(1);
});
