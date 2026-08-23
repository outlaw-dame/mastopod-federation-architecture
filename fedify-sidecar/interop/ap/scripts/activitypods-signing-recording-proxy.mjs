#!/usr/bin/env node
import http from 'node:http';
import { isIP } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const listenHost = process.env.AP_SIGNING_PROXY_HOST || '127.0.0.1';
const listenPort = parseIntegerEnv('AP_SIGNING_PROXY_PORT', 3001, 1, 65535);
const targetHost = process.env.AP_SIGNING_PROXY_TARGET_HOST || '127.0.0.1';
const targetPort = parseIntegerEnv('AP_SIGNING_PROXY_TARGET_PORT', 3000, 1, 65535);
const evidencePath = process.env.AP_SIGNING_PROXY_EVIDENCE_PATH || 'measurements/ap-federation/signing-api.jsonl';
const maxBodyBytes = parseIntegerEnv('AP_SIGNING_PROXY_MAX_BODY_BYTES', 2 * 1024 * 1024, 1024, 10 * 1024 * 1024);
const timeoutMs = parseIntegerEnv('AP_SIGNING_PROXY_TIMEOUT_MS', 15000, 1000, 60000);
const signingPath = '/api/internal/signatures/batch';
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
    const upstream = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers
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

          // Signing responses remain gated on durable redacted evidence. Inbox
          // pass-through is deliberately not recorded here: the sidecar Redis
          // stream is the authoritative return-path evidence and avoids writing
          // raw ActivityPub bodies or signature headers to an extra artifact.
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
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

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`ActivityPods signing recording proxy listening on ${listenHost}:${listenPort}\n`);
});
