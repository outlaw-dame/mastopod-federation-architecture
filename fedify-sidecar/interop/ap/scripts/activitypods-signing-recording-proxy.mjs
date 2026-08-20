#!/usr/bin/env node
import http from 'node:http';
import { appendFile } from 'node:fs/promises';

const listenHost = process.env.AP_SIGNING_PROXY_HOST || '0.0.0.0';
const listenPort = Number(process.env.AP_SIGNING_PROXY_PORT || 3001);
const targetHost = process.env.AP_SIGNING_PROXY_TARGET_HOST || '127.0.0.1';
const targetPort = Number(process.env.AP_SIGNING_PROXY_TARGET_PORT || 3000);
const evidencePath = process.env.AP_SIGNING_PROXY_EVIDENCE_PATH || 'measurements/ap-federation/signing-api.jsonl';
const maxBodyBytes = Number(process.env.AP_SIGNING_PROXY_MAX_BODY_BYTES || 2 * 1024 * 1024);

function redactHeaders(headers) {
  const out = { ...headers };
  if (out.authorization) out.authorization = '<redacted>';
  return out;
}

async function writeEvidence(record) {
  await appendFile(evidencePath, `${JSON.stringify(record)}\n`, 'utf8');
}

const server = http.createServer((req, res) => {
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
        upstreamRes.on('data', chunk => {
          responseBytes += chunk.length;
          if (responseBytes <= maxBodyBytes) responseChunks.push(chunk);
          res.write(chunk);
        });
        upstreamRes.on('end', async () => {
          res.end();
          if (req.url === '/api/internal/signatures/batch' && req.method === 'POST') {
            let requestJson = null;
            let responseJson = null;
            try { requestJson = JSON.parse(body.toString('utf8')); } catch {}
            try { responseJson = JSON.parse(Buffer.concat(responseChunks).toString('utf8')); } catch {}
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
          }
        });
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      }
    );
    upstream.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_upstream_failure' }));
      void writeEvidence({
        schema: 'ap.real-signing-api-proxy-error.v1',
        observedAt: Date.now(),
        method: req.method,
        path: req.url,
        error: error.message
      });
    });
    upstream.end(body);
  });
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`ActivityPods signing recording proxy listening on ${listenHost}:${listenPort}\n`);
});
