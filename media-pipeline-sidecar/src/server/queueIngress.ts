import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { enqueue } from '../queue/producer';
import { initRedis, redis } from '../queue/redisClient';
import { sanitizeOptionalText } from '../ingest/sanitizeMetadata';
import { logger } from '../logger';

const bodySchema = z.object({
  sourceUrl: z.string().url().max(2048),
  ownerId: z.string().min(1).max(512),
  alt: z.string().max(500).optional(),
  contentWarning: z.string().max(300).optional(),
  isSensitive: z.boolean().optional()
});

function isAuthorized(authorizationHeader: string | undefined): boolean {
  if (!config.token || !authorizationHeader) return false;
  const expected = Buffer.from(`Bearer ${config.token}`);
  const provided = Buffer.from(authorizationHeader);
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

function writeJson(response: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new Error('content-type must be application/json');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > config.ingressMaxBodyBytes) {
      throw new Error(`request body exceeds limit (${config.ingressMaxBodyBytes} bytes)`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      writeJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && request.url === '/ready') {
      writeJson(response, 200, {
        status: redis.isReady ? 'ready' : 'not-ready'
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/internal/media/ingest') {
      if (!isAuthorized(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined)) {
        writeJson(response, 401, { error: 'unauthorized' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        writeJson(response, 400, {
          error: 'invalid-request-body',
          detail: err instanceof Error ? err.message : 'invalid body'
        });
        return;
      }

      const parsed = bodySchema.safeParse(body || {});
      if (!parsed.success) {
        writeJson(response, 400, {
          error: 'invalid-request-body',
          details: parsed.error.flatten()
        });
        return;
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

      writeJson(response, 200, { status: 'queued', traceId });
      return;
    }

    writeJson(response, 404, { error: 'not-found' });
  } catch (err) {
    logger.error({ err }, 'queue-ingress-unhandled-error');
    writeJson(response, 500, { error: 'internal-error' });
  }
});

async function main(): Promise<void> {
  if (!config.token) {
    throw new Error('INTERNAL_BEARER_TOKEN must be set');
  }
  await initRedis();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  logger.info({ host: config.host, port: config.port }, 'queue-ingress-listening');
}

main().catch((err) => {
  logger.error({ err }, 'queue-ingress-startup-error');
  process.exit(1);
});
