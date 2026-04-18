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
import { handleLocalMediaDelivery } from './localMediaDelivery';
import { appendVaryHeader, resolveLocale, t, type Locale } from './i18n';

const bodySchema = z.object({
  sourceUrl: z.string().url().max(2048),
  ownerId: z.string().min(1).max(512),
  sourceResolver: z.enum(['activitypods-file']).optional(),
  alt: z.string().max(500).optional(),
  contentWarning: z.string().max(300).optional(),
  isSensitive: z.boolean().optional()
}).superRefine((value, ctx) => {
  try {
    const parsed = new URL(value.sourceUrl);
    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourceUrlCredentials',
        path: ['sourceUrl']
      });
    }
  } catch {
    // zod url validation already covers this path
  }
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

function writeJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
  locale: Locale,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-language', locale);
  response.setHeader('vary', appendVaryHeader(response.getHeader('vary'), 'Accept-Language'));
  response.end(JSON.stringify(payload));
}

function sanitizeOwnerId(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 512);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new Error('contentTypeJson');
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
    const locale = resolveLocale(request.headers['accept-language']);

    if (await handleLocalMediaDelivery(request, response)) {
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      writeJson(response, 200, { status: 'ok' }, locale);
      return;
    }

    if (request.method === 'GET' && request.url === '/ready') {
      writeJson(response, 200, {
        status: redis.isReady ? 'ready' : 'not-ready'
      }, locale);
      return;
    }

    if (request.method === 'POST' && request.url === '/internal/media/ingest') {
      if (!isAuthorized(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined)) {
        writeJson(response, 401, { error: 'unauthorized' }, locale);
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        writeJson(response, 400, {
          error: 'invalid-request-body',
          detail: err instanceof Error
            ? translateIngressDetail(locale, err.message)
            : t(locale, 'ingress.invalidBody')
        }, locale);
        return;
      }

      const parsed = bodySchema.safeParse(body || {});
      if (!parsed.success) {
        writeJson(response, 400, {
          error: 'invalid-request-body',
          details: localizeFlattenedValidation(parsed.error.flatten(), locale)
        }, locale);
        return;
      }

      const traceId = randomUUID();
      const ownerId = sanitizeOwnerId(parsed.data.ownerId);
      if (!ownerId) {
        writeJson(response, 400, {
          error: 'invalid-request-body',
          detail: t(locale, 'ingress.ownerPrintable')
        }, locale);
        return;
      }

      await enqueue(MediaStreams.INGEST, {
        traceId,
        sourceUrl: parsed.data.sourceUrl,
        ownerId,
        sourceResolver: parsed.data.sourceResolver || '',
        alt: sanitizeOptionalText(parsed.data.alt, 500),
        contentWarning: sanitizeOptionalText(parsed.data.contentWarning, 300),
        isSensitive: String(Boolean(parsed.data.isSensitive))
      });

      writeJson(response, 202, { status: 'queued', traceId }, locale);
      return;
    }

    writeJson(response, 404, { error: 'not-found' }, locale);
  } catch (err) {
    const locale = resolveLocale(request.headers['accept-language']);
    logger.error({ err }, 'queue-ingress-unhandled-error');
    writeJson(response, 500, { error: 'internal-error' }, locale);
  }
});

function translateIngressDetail(locale: Locale, message: string): string {
  if (message === 'contentTypeJson') {
    return t(locale, 'ingress.contentTypeJson')
  }
  if (message === 'sourceUrlCredentials') {
    return t(locale, 'ingress.sourceUrlCredentials')
  }
  return message
}

function localizeFlattenedValidation(
  flattened: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> },
  locale: Locale,
) {
  const fieldErrors = Object.fromEntries(
    Object.entries(flattened.fieldErrors).map(([field, messages]) => [
      field,
      messages?.map(message => translateIngressDetail(locale, message)),
    ]),
  )

  const formErrors = flattened.formErrors.map(message => translateIngressDetail(locale, message))

  return {
    ...flattened,
    fieldErrors,
    formErrors,
  }
}

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
