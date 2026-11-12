#!/usr/bin/env node
import http from 'node:http';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const listenHost = process.env.AP_SIGNING_PROXY_HOST || '127.0.0.1';
const listenPort = parseIntegerEnv('AP_SIGNING_PROXY_PORT', 3001, 1, 65535);
const targetHost = process.env.AP_SIGNING_PROXY_TARGET_HOST || '127.0.0.1';
const targetPort = parseIntegerEnv('AP_SIGNING_PROXY_TARGET_PORT', 3000, 1, 65535);
const evidencePath = process.env.AP_SIGNING_PROXY_EVIDENCE_PATH || 'measurements/ap-federation/signing-api.jsonl';
const maxBodyBytes = parseIntegerEnv('AP_SIGNING_PROXY_MAX_BODY_BYTES', 2 * 1024 * 1024, 1024, 10 * 1024 * 1024);
const timeoutMs = parseIntegerEnv('AP_SIGNING_PROXY_TIMEOUT_MS', 120000, 1000, 300000);
const recordInbound = process.env.AP_SIGNING_PROXY_RECORD_INBOUND === 'true';
const signingPath = '/api/internal/signatures/batch';
const inboundReceiverPath = '/api/internal/activitypub-bridge/inbox/receive';
const actorInboxPath = /^\/(?:users\/)?[A-Za-z0-9._-]{1,128}\/inbox\/?$/u;

if (!isPrivateBindHost(listenHost)) {
  throw new Error('AP_SIGNING_PROXY_HOST must be loopback or an explicit RFC1918 Docker bridge address');
}
if (!['127.0.0.1', '::1', 'localhost'].includes(targetHost)) {
  throw new Error('AP_SIGNING_PROXY_TARGET_HOST must resolve explicitly to the local loopback interface');
}

function parseIntegerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function isPrivateBindHost(value) {
  if (['127.0.0.1', '::1', 'localhost'].includes(value)) return true;
  if (isIP(value) !== 4) return false;
  const octets = value.split('.').map(part => Number.parseInt(part, 10));
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
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

function redactHeaders(headers) {
  const out = { ...headers };
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']) {
    if (out[name]) out[name] = '<redacted>';
  }
  return out;
}

async function writeEvidence(record) {
  await mkdir(dirname(evidencePath), { recursive: true });
  await appendFile(evidencePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function recordEvidence(record) {
  void writeEvidence(record).catch(() => {
    process.stderr.write('ActivityPods signing recording proxy could not persist evidence\n');
  });
}

function classifyRequest(req) {
  if (req.method === 'POST' && req.url === signingPath) return 'signing';
  const path = typeof req.url === 'string' ? req.url.split('?', 1)[0] : '';
  if (req.method === 'POST' && path === inboundReceiverPath) return 'inbound';
  if (req.method === 'POST' && actorInboxPath.test(path)) return 'inbound';
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS' && req.url === '/ready') {
    res.writeHead(204).end();
    return;
  }

  const requestClass = classifyRequest(req);
  if (!requestClass) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > maxBodyBytes) {
      aborted = true;
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const startedAt = Date.now();
    const forwardedHeaders = filterHopByHopHeaders(req.headers);
    forwardedHeaders['content-length'] = String(body.length);
    if (req.headers.host) {
      forwardedHeaders.host = req.headers.host;
    }
    const upstream = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        setHost: false,
        headers: forwardedHeaders
      },
      upstreamRes => {
        const responseChunks = [];
        let responseBytes = 0;
        let responseTooLarge = false;

        upstreamRes.on('data', chunk => {
          responseBytes += chunk.length;
          if (responseBytes > maxBodyBytes) {
            responseTooLarge = true;
            return;
          }
          responseChunks.push(chunk);
        });
        upstreamRes.on('end', async () => {
          if (responseTooLarge) {
            res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'proxy_upstream_response_too_large' }));
            if (requestClass === 'signing') {
              recordEvidence({
                schema: 'ap.real-signing-api-proxy-error.v1',
                observedAt: Date.now(),
                method: req.method,
                path: req.url,
                errorCode: 'upstream_response_too_large'
              });
            }
            return;
          }

          const responseBody = Buffer.concat(responseChunks);
          if (requestClass === 'signing') {
            let requestJson = null;
            let responseJson = null;
            try { requestJson = JSON.parse(body.toString('utf8')); } catch {}
            try { responseJson = JSON.parse(responseBody.toString('utf8')); } catch {}
            try {
              await writeEvidence({
                schema: 'ap.real-signing-api-call.v1',
                observedAt: Date.now(),
                durationMs: Date.now() - startedAt,
                method: req.method,
                path: req.url,
                requestHeaders: redactHeaders(req.headers),
                request: requestJson,
                responseStatus: upstreamRes.statusCode,
                response: responseJson
              });
            } catch {
              res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'proxy_evidence_write_failure' }));
              process.stderr.write('ActivityPods signing recording proxy could not persist evidence\n');
              return;
            }
          }

          if (requestClass === 'inbound' && recordInbound) {
            let activity = null;
            try { activity = JSON.parse(body.toString('utf8')); } catch {}
            const object = activity && typeof activity.object === 'object' && !Array.isArray(activity.object)
              ? activity.object
              : null;
            try {
              await writeEvidence({
                schema: 'ap.real-inbound-api-call.v1',
                observedAt: Date.now(),
                durationMs: Date.now() - startedAt,
                method: req.method,
                path: req.url,
                responseStatus: upstreamRes.statusCode,
                bodyBytes: body.length,
                bodySha256Base64: createHash('sha256').update(body).digest('base64'),
                activityId: entityId(activity),
                activityType: normalizedType(activity?.type),
                actorUri: entityId(activity?.actor),
                actorEncoding: entityEncoding(activity?.actor),
                objectId: entityId(activity?.object),
                objectType: normalizedType(object?.type),
                objectActorUri: entityId(object?.actor),
                objectActorEncoding: entityEncoding(object?.actor),
                objectTargetUri: entityId(object?.object)
              });
            } catch {
              res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'proxy_evidence_write_failure' }));
              process.stderr.write('ActivityPods inbound recording proxy could not persist evidence\n');
              return;
            }
          }

          // Signing responses and explicitly enabled native inbox receipts are
          // gated on durable, bounded, semantic-only evidence. No raw inbound
          // body, authentication material, or signature header is persisted.
          const responseHeaders = filterHopByHopHeaders(upstreamRes.headers);
          responseHeaders['content-length'] = String(responseBody.length);
          res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
          res.end(responseBody);
        });
      }
    );
    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('upstream_timeout')));
    upstream.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_upstream_failure' }));
      if (requestClass === 'signing') {
        recordEvidence({
          schema: 'ap.real-signing-api-proxy-error.v1',
          observedAt: Date.now(),
          method: req.method,
          path: req.url,
          errorCode: error.message === 'upstream_timeout' ? 'upstream_timeout' : 'upstream_request_failed'
        });
      }
    });
    upstream.end(body);
  });
});

function entityId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
  const atId = typeof value['@id'] === 'string' && value['@id'].length > 0 ? value['@id'] : null;
  if (id && atId && id !== atId) return null;
  return id || atId;
}

function entityEncoding(value) {
  if (typeof value === 'string' && value.length > 0) return 'iri';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
  const atId = typeof value['@id'] === 'string' && value['@id'].length > 0 ? value['@id'] : null;
  if (id && atId && id !== atId) return 'conflicting-identifiers';
  if (id) return 'object-id';
  if (atId) return 'object-at-id';
  return 'invalid';
}

function normalizedType(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!Array.isArray(value)) return null;
  return value.find(item => typeof item === 'string' && item.length > 0) ?? null;
}

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`ActivityPods signing recording proxy listening on ${listenHost}:${listenPort}\n`);
});
