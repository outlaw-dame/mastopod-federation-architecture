import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';
import { fetchMedia } from './fetcher.js';
import { processImage, sha256 } from './processing.js';
import { uploadObject } from './storage.js';

const app = Fastify({ logger: false });

function auth(req: any) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${config.token}`;
}

app.get('/health', async () => ({ status: 'ok' }));

app.post('/internal/media/resolve', async (req: any, reply) => {
  if (!auth(req)) return reply.code(401).send();

  const { mediaUrl } = req.body;
  const { bytes, mime } = await fetchMedia(mediaUrl);

  return {
    mediaUrl,
    mimeType: mime,
    bytesBase64: Buffer.from(bytes).toString('base64'),
    size: bytes.byteLength,
    resolvedAt: new Date().toISOString()
  };
});

app.post('/internal/media/ingest', async (req: any, reply) => {
  if (!auth(req)) return reply.code(401).send();

  const { bytesBase64, sourceUrl, mimeType } = req.body;

  const bytes = bytesBase64
    ? Buffer.from(bytesBase64, 'base64')
    : (await fetchMedia(sourceUrl)).bytes;

  const processed = await processImage(bytes);
  const hash = sha256(processed.webp);

  const key = `${hash}.webp`;
  const url = await uploadObject(key, processed.webp, 'image/webp');

  return {
    assetId: hash,
    original: { url, mimeType: 'image/webp', size: processed.webp.length },
    variants: [],
    sha256: hash,
    createdAt: new Date().toISOString()
  };
});

app.listen({ port: config.port, host: config.host }).then(() => {
  logger.info(`Media pipeline running on ${config.port}`);
});
