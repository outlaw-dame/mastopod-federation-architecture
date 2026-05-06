import { createHash } from 'node:crypto';
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
  sourceHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  sourceResolver: z.enum(['activitypods-file']).optional(),
  sourceToken: z.string().max(1024).optional(),
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

// ---------------------------------------------------------------------------
// Rate limiting — sliding window per source domain (Redis sorted set)
// ---------------------------------------------------------------------------

function sourceDomainKey(sourceUrl: string): string | null {
  try {
    const { hostname } = new URL(sourceUrl);
    const safe = hostname.replace(/[^a-z0-9.-]/gi, '');
    return `media:ratelimit:domain:${safe}`;
  } catch {
    return null;
  }
}

async function checkRateLimit(sourceUrl: string, traceId: string): Promise<boolean> {
  if (!config.ingressRateLimitEnabled) return true;
  const key = sourceDomainKey(sourceUrl);
  if (!key) return true;

  const now = Date.now();
  const windowStart = now - config.ingressRateLimitWindowMs;
  const member = `${now}:${traceId}`;
  const ttlSeconds = Math.ceil((config.ingressRateLimitWindowMs * 2) / 1000);

  // Remove expired entries, count remaining, add current (best-effort atomic via pipeline)
  const pipeline = redis.multi();
  pipeline.zRemRangeByScore(key, 0, windowStart);
  pipeline.zCard(key);
  pipeline.zAdd(key, [{ score: now, value: member }]);
  pipeline.expire(key, ttlSeconds);
  const results = await pipeline.exec();

  // zCard result is the second command (index 1), before we added the new entry
  const countBeforeAdd = typeof results[1] === 'number' ? results[1] : 0;
  if (countBeforeAdd >= config.ingressRateLimitMaxPerMinute) {
    // Undo the add we speculatively inserted
    await redis.zRem(key, member).catch(() => {});
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Content deduplication — URL-level dedup via SHA-256 hash + Redis TTL
// ---------------------------------------------------------------------------

function dedupKey(sourceUrl: string): string {
  const hash = createHash('sha256').update(sourceUrl).digest('hex');
  return `media:dedup:${hash}`;
}

function normalizeSha256(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function contentHashDedupKey(sourceHash: string): string {
  return `media:dedup:sha256:${sourceHash}`;
}

async function checkAndMarkDedup(sourceUrl: string, sourceHash?: string): Promise<boolean> {
  const normalizedHash = normalizeSha256(sourceHash);
  if (normalizedHash && config.ingressContentHashDedupEnabled) {
    const hashKey = contentHashDedupKey(normalizedHash);
    const hashResult = await redis.set(hashKey, '1', {
      NX: true,
      EX: config.ingressContentHashDedupTtlSeconds,
    });
    if (hashResult === null) {
      return false;
    }
  }

  if (!config.ingressDedupEnabled) return true;
  const key = dedupKey(sourceUrl);
  // NX: only set if not exists; returns 1 if set, null if already present
  const result = await redis.set(key, '1', {
    NX: true,
    EX: config.ingressDedupTtlSeconds
  });
  return result !== null; // true = new (allow), false = duplicate (reject)
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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

      // Rate limit check (per source domain)
      const withinLimit = await checkRateLimit(parsed.data.sourceUrl, traceId);
      if (!withinLimit) {
        writeJson(response, 429, { error: 'rate-limit-exceeded', traceId }, locale);
        return;
      }

      // Content deduplication (URL-level, short-circuit if already in-flight or recently processed)
      const isNew = await checkAndMarkDedup(parsed.data.sourceUrl, parsed.data.sourceHash);
      if (!isNew) {
        writeJson(response, 409, { status: 'duplicate', traceId }, locale);
        return;
      }

      // Enqueue directly to FETCH stream (eliminates no-op INGEST hop)
      await enqueue(MediaStreams.FETCH, {
        traceId,
        sourceUrl: parsed.data.sourceUrl,
        ownerId,
        sourceResolver: parsed.data.sourceResolver || '',
        sourceToken: parsed.data.sourceToken || '',
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

  if (config.mediaObjectStoreBackend === 's3' && !config.s3.bucket) {
    logger.warn(
      'S3 object store backend is configured but S3_BUCKET is not set — all media uploads will fail'
    );
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
