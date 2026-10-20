#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { dirname } from 'node:path';
import { request } from 'undici';

const HOST = process.env.AP_WIRE_RECORDER_HOST || '0.0.0.0';
const PORT = positiveInteger(process.env.AP_WIRE_RECORDER_PORT, 8788, 'AP_WIRE_RECORDER_PORT');
const UPSTREAM = new URL(process.env.AP_WIRE_RECORDER_UPSTREAM || 'http://mastodon-web-app:3000');
const EVIDENCE_PATH = process.env.AP_WIRE_RECORDER_EVIDENCE_PATH || '/evidence/mastodon.jsonl';
const MAX_BODY_BYTES = positiveInteger(process.env.AP_WIRE_RECORDER_MAX_BODY_BYTES, 2 * 1024 * 1024, 'AP_WIRE_RECORDER_MAX_BODY_BYTES');
const MAX_RESPONSE_BYTES = positiveInteger(process.env.AP_WIRE_RECORDER_MAX_RESPONSE_BYTES, 4 * 1024 * 1024, 'AP_WIRE_RECORDER_MAX_RESPONSE_BYTES');

if (process.env.NODE_ENV === 'production' && process.env.AP_INTEROP_WIRE_RECORDER_ENABLED !== 'true') {
  throw new Error('ActivityPub wire recorder is test/development-only');
}
if (!['http:', 'https:'].includes(UPSTREAM.protocol) || UPSTREAM.username || UPSTREAM.password || UPSTREAM.search || UPSTREAM.hash) {
  throw new Error('AP_WIRE_RECORDER_UPSTREAM must be a credential-free HTTP(S) origin');
}

await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
let writeChain = Promise.resolve();
const getCache = new Map();

function getFromCache(req, target) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const accept = String(req.headers.accept || '');
  const key = `${req.method}:${target.pathname}${target.search}:${accept}`;
  const entry = getCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    getCache.delete(key);
    return null;
  }
  return entry;
}

function saveToCache(req, target, statusCode, headers, body) {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || statusCode !== 200) return;
  const accept = String(req.headers.accept || '');
  const key = `${req.method}:${target.pathname}${target.search}:${accept}`;
  getCache.set(key, {
    statusCode,
    headers: { ...headers },
    body: Buffer.from(body),
    expiresAt: Date.now() + 60_000,
  });
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let requestEvidence = null;
  try {
    const body = await readBoundedBody(req, MAX_BODY_BYTES);
    const target = new URL(req.url || '/', UPSTREAM);
    const forwardedHeaders = filterHopByHopHeaders(req.headers);
    // Preserve the public ActivityPub authority observed by the signer and the
    // remote implementation. The transport endpoint alone changes.
    if (req.headers.host) forwardedHeaders.host = req.headers.host;
    forwardedHeaders['content-length'] = String(body.length);

    requestEvidence = buildEvidence(req, body);
    if (requestEvidence) {
      await appendEvidence(requestEvidence);
    }

    const cached = getFromCache(req, target);
    if (cached) {
      if (requestEvidence) await appendEvidence(buildResponseEvidence(requestEvidence, cached.statusCode, cached.body.length, startedAt, true));
      res.writeHead(cached.statusCode, cached.headers);
      res.end(cached.body);
      return;
    }

    const upstream = await request(target, {
      method: req.method,
      headers: forwardedHeaders,
      body: body.length > 0 ? body : undefined,
      bodyTimeout: 120_000,
      headersTimeout: 120_000,
      maxRedirections: 0,
    });
    const responseBody = await readBoundedUndiciBody(upstream.body, MAX_RESPONSE_BYTES);
    const responseHeaders = filterHopByHopHeaders(upstream.headers);
    responseHeaders['content-length'] = String(responseBody.length);
    saveToCache(req, target, upstream.statusCode, responseHeaders, responseBody);
    if (requestEvidence) await appendEvidence(buildResponseEvidence(requestEvidence, upstream.statusCode, responseBody.length, startedAt, false));
    res.writeHead(upstream.statusCode, responseHeaders);
    res.end(responseBody);
  } catch (error) {
    if (requestEvidence) {
      await appendEvidence({
        schema: 'ap.interop.wire-response.v1',
        observedAt: Date.now(),
        requestId: requestEvidence.requestId,
        activityId: requestEvidence.activityId,
        upstreamStatus: null,
        responseBytes: 0,
        durationMs: Date.now() - startedAt,
        cached: false,
        errorCode: safeErrorCode(error),
      }).catch(() => {});
    }
    const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 502;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 413 ? 'request body too large' : 'wire recorder upstream failure');
    console.error('[ap-wire-recorder]', error instanceof Error ? error.stack : String(error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    schema: 'ap.interop.wire-recorder.ready.v1',
    host: HOST,
    port: PORT,
    upstream: UPSTREAM.origin,
    evidencePath: EVIDENCE_PATH,
  }));
});

function buildEvidence(req, body) {
  const signature = singleHeader(req.headers.signature);
  const digest = singleHeader(req.headers.digest);
  const date = singleHeader(req.headers.date);
  if (!signature && !digest && body.length === 0) return null;

  let activity = null;
  const contentType = singleHeader(req.headers['content-type']) || '';
  if (body.length > 0 && /(?:activity\+json|ld\+json|application\/json)/iu.test(contentType)) {
    try { activity = JSON.parse(body.toString('utf8')); } catch { activity = null; }
  }

  return {
    schema: 'ap.interop.wire-request.v1',
    requestId: randomUUID(),
    observedAt: Date.now(),
    method: req.method || '',
    path: req.url || '/',
    host: singleHeader(req.headers.host),
    contentType,
    date,
    digest,
    signature,
    bodyBytes: body.length,
    bodySha256Base64: createHash('sha256').update(body).digest('base64'),
    activityId: stringOrNull(activity?.id),
    activityType: normalizeType(activity?.type),
    actorUri: normalizeEntityId(activity?.actor),
    objectUri: normalizeEntityId(activity?.object),
  };
}

function buildResponseEvidence(requestEvidence, upstreamStatus, responseBytes, startedAt, cached) {
  return {
    schema: 'ap.interop.wire-response.v1',
    observedAt: Date.now(),
    requestId: requestEvidence.requestId,
    activityId: requestEvidence.activityId,
    upstreamStatus,
    responseBytes,
    durationMs: Date.now() - startedAt,
    cached,
    errorCode: null,
  };
}

async function appendEvidence(evidence) {
  writeChain = writeChain.then(() => appendFile(EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`, 'utf8'));
  await writeChain;
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UPSTREAM_FAILURE';
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'UPSTREAM_FAILURE';
}

function normalizeType(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  return null;
}

function normalizeEntityId(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return stringOrNull(value.id) || stringOrNull(value['@id']);
  }
  return null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function singleHeader(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : value.join(', ');
  return typeof value === 'string' ? value : null;
}

function filterHopByHopHeaders(headers) {
  const connectionTokens = new Set(
    String(singleHeader(headers.connection) || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...connectionTokens,
  ]);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

async function readBoundedBody(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedUndiciBody(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new Error(`upstream response exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function positiveInteger(value, fallback, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
