import http from 'node:http';
import { runSmokeHarness } from './lib/smokeHarness';

function createServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to allocate server port'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function main(): Promise<void> {
  let mediaMock: { server: http.Server; port: number } | undefined;

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64'
  );

  try {
    mediaMock = await createServer(async (_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'image/png');
      res.setHeader('content-length', String(pngBytes.byteLength));
      res.end(pngBytes);
    });

    const result = await runSmokeHarness({
      sourceUrl: `http://127.0.0.1:${mediaMock.port}/media/1.png`,
      runSsrfValidation: false,
      expectedKind: 'image'
    });

    console.log('smoke-runtime: success');
    console.log(`assetId=${result.assetId}`);
  } finally {
    if (mediaMock) {
      await closeServer(mediaMock.server);
    }
  }
}

main().catch(async (err) => {
  console.error('smoke-runtime: failed');
  console.error(err);
  process.exit(1);
});
