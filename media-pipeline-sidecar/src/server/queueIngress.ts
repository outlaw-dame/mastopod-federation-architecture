import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { enqueue } from '../queue/producer';
import { initRedis } from '../queue/redisClient';

const app = Fastify({ logger: false });

function isAuthorized(headers: Record<string, unknown>): boolean {
  return headers.authorization === `Bearer ${config.token}`;
}

app.get('/health', async () => ({ status: 'ok' }));

app.post('/internal/media/ingest', async (request: any, reply) => {
  if (!isAuthorized(request.headers)) return reply.code(401).send();

  const { sourceUrl, ownerId, alt, contentWarning, isSensitive } = request.body || {};
  if (!sourceUrl || !ownerId) {
    return reply.code(400).send({ error: 'sourceUrl and ownerId are required' });
  }

  const traceId = randomUUID();
  await enqueue(MediaStreams.INGEST, {
    traceId,
    sourceUrl,
    ownerId,
    alt: alt || '',
    contentWarning: contentWarning || '',
    isSensitive: String(Boolean(isSensitive))
  });

  return { status: 'queued', traceId };
});

async function main(): Promise<void> {
  await initRedis();
  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
