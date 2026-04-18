import { runSmokeHarness } from './lib/smokeHarness';
import { closeFixtureServer, createStaticFixtureServer } from './lib/staticFixtureServer';

async function main(): Promise<void> {
  let mediaMock: Awaited<ReturnType<typeof createStaticFixtureServer>> | undefined;

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64'
  );

  try {
    mediaMock = await createStaticFixtureServer({
      pathname: '/media/1.png',
      contentType: 'image/png',
      body: pngBytes
    });

    const result = await runSmokeHarness({
      sourceUrl: mediaMock.url,
      runSsrfValidation: false,
      expectedKind: 'image'
    });

    console.log('smoke-runtime: success');
    console.log(`assetId=${result.assetId}`);
  } finally {
    if (mediaMock) {
      await closeFixtureServer(mediaMock.server);
    }
  }
}

main().catch(async (err) => {
  console.error('smoke-runtime: failed');
  console.error(err);
  process.exit(1);
});
