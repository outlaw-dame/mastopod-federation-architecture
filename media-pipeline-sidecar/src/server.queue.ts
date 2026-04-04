import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';
import { enqueue } from './queue/producer.js';
import { MediaStreams } from './contracts/MediaStreams.js';
import { initRedis } from './queue/redisClient.js';
import { randomUUID } from 'node:crypto';

const app = Fastify({ logger: false });

function auth(req: any) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${config.token}`;
}

app.get('/health', async () => ({ status: 'ok' }));

app.post('/internal/media/ingest', async (req: any, reply) => {
  if (!auth(req)) return reply.code(401).send();

  const { sourceUrl } = req.body;
  if (!sourceUrl) return reply.code(400).send({ error: 'sourceUrl required' });

  const traceId = randomUUID();

  await enqueue(MediaStreams.INGEST, {
    url: sourceUrl,
    traceId
  });

  return {
    status: 'queued',
    traceId
  };
});

async function start() {
  await initRedis();
  await app.listen({ port: config.port, host: config.host });
  logger.info(`Queue ingress running on ${config.port}`);
}

start().catch(err => {
  logger.error({ err }, 'Failed to start');
  process.exit(1);
});
