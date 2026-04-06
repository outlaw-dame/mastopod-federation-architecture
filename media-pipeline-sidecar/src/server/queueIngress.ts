import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { enqueue } from '../queue/producer';
import { initRedis } from '../queue/redisClient';
import { sanitizeOptionalText } from '../ingest/sanitizeMetadata';

const bodySchema = z.object({
  sourceUrl: z.string().url().max(2048),
  ownerId: z.string().min(1).max(512),
  alt: z.string().max(500).optional(),
  contentWarning: z.string().max(300).optional(),
  isSensitive: z.boolean().optional()
});

const app = Fastify({ logger: false });

function isAuthorized(headers: Record<string, unknown>): boolean {
  return headers.authorization === `Bearer ${config.token}`;
}

app.get('/health', async () => ({ status: 'ok' }));

app.post('/internal/media/ingest', async (request: any, reply) => {
  if (!isAuthorized(request.headers)) return reply.code(401).send();

  const parsed = bodySchema.safeParse(request.body || {});
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'Invalid request body',
      details: parsed.error.flatten()
    });
  }

  const traceId = randomUUID();
  await enqueue(MediaStreams.INGEST, {
    traceId,
    sourceUrl: parsed.data.sourceUrl,
    ownerId: parsed.data.ownerId,
    alt: sanitizeOptionalText(parsed.data.alt, 500),
    contentWarning: sanitizeOptionalText(parsed.data.contentWarning, 300),
    isSensitive: String(Boolean(parsed.data.isSensitive))
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
