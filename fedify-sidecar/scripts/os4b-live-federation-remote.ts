import Fastify from 'fastify';
import { signRequest } from '@fedify/fedify';

const host = process.env.OS4B_REMOTE_HOST ?? '127.0.0.1';
const port = Number(process.env.OS4B_REMOTE_PORT ?? 18181);
const publicHost = process.env.OS4B_REMOTE_PUBLIC_HOST ?? host;
const publicPort = Number(process.env.OS4B_REMOTE_PUBLIC_PORT ?? port);
const sidecarInbox = process.env.OS4B_SIDECAR_INBOX ?? 'http://127.0.0.1:18080/inbox';
const sidecarHostHeader = process.env.OS4B_SIDECAR_HOST_HEADER ?? 'local.test';
const count = Number(process.env.OS4B_FEDERATION_COUNT ?? 240);
const concurrency = Math.max(1, Number(process.env.OS4B_FEDERATION_CONCURRENCY ?? 24));
const marker = process.env.OS4B_FEDERATION_MARKER ?? `os4b-live-${Date.now()}`;
const invalidMarker = `${marker}-invalid-signature`;
const actorUri = `http://${publicHost}:${publicPort}/users/remote`;
const keyId = `${actorUri}#main-key`;

const keyPair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const spki = Buffer.from(await crypto.subtle.exportKey('spki', keyPair.publicKey));
const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
const app = Fastify({ logger: false });
let actorDocumentFetches = 0;

app.get('/health', async () => ({ ok: true }));
app.get('/users/remote', async (_request, reply) => {
  actorDocumentFetches += 1;
  reply.type('application/activity+json').send({
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id: actorUri,
    type: 'Person',
    preferredUsername: 'remote',
    url: actorUri,
    inbox: `http://${publicHost}:${publicPort}/users/remote/inbox`,
    publicKey: { id: keyId, owner: actorUri, publicKeyPem },
  });
});

await app.listen({ host, port });

function buildActivity(i: number, contentMarker = marker) {
  const published = new Date(1_750_000_000_000 + i * 1000).toISOString();
  const objectId = `${actorUri}/notes/${contentMarker}-${i}`;
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUri}/activities/${contentMarker}-${i}`,
    type: 'Create',
    actor: actorUri,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: {
      id: objectId,
      type: 'Note',
      attributedTo: actorUri,
      content: `<p>${contentMarker} live federation note ${i} kiwi orbit</p>`,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
    published,
  };
}

async function createSignedHeaders(body: string): Promise<Record<string, string>> {
  // Keep the Cavage signature surface minimal. Fedify's draft signer signs
  // every header present on the Request, so only expose Host before signing;
  // it then adds Date + Digest itself. Content-Type/Accept are transport
  // metadata and are appended after signing, matching common Fediverse peers.
  const visibleUrl = new URL(sidecarInbox);
  visibleUrl.hostname = sidecarHostHeader;
  visibleUrl.port = '';
  const bodyBytes = Buffer.from(body, 'utf8');
  const unsigned = new Request(visibleUrl, {
    method: 'POST',
    headers: { host: sidecarHostHeader },
    body: bodyBytes,
  });
  const signed = await signRequest(unsigned, keyPair.privateKey, new URL(keyId), {
    spec: 'draft-cavage-http-signatures-12',
    body: bodyBytes,
  });
  const headers: Record<string, string> = {};
  signed.headers.forEach((value, name) => { headers[name] = value; });
  headers.host = sidecarHostHeader;
  headers['content-type'] = 'application/activity+json';
  headers.accept = 'application/activity+json';
  return headers;
}

async function sendInvalidSignatureControl() {
  const body = JSON.stringify(buildActivity(-1, invalidMarker));
  const headers = await createSignedHeaders(body);
  const signatureName = Object.keys(headers).find((name) => name.toLowerCase() === 'signature');
  if (!signatureName) throw new Error('Fedify signRequest did not emit Signature header for Cavage request');
  headers[signatureName] = `${headers[signatureName]!.slice(0, -8)}INVALID!`;
  const response = await fetch(sidecarInbox, { method: 'POST', headers, body });
  const responseBody = await response.text();
  if (response.status >= 200 && response.status < 300) {
    throw new Error(`invalid-signature control was accepted with ${response.status}: ${responseBody}`);
  }
  return { status: response.status, body: responseBody.slice(0, 512) };
}

const startedAt = Date.now();
let next = 0;
const latencies: number[] = [];

try {
  const invalidSignature = await sendInvalidSignatureControl();

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= count) return;
      const activity = buildActivity(i);
      const body = JSON.stringify(activity);
      const requestStartedAt = Date.now();
      const response = await fetch(sidecarInbox, {
        method: 'POST',
        headers: await createSignedHeaders(body),
        body,
      });
      latencies.push(Date.now() - requestStartedAt);
      if (response.status !== 202) {
        throw new Error(
          `federation POST ${i} returned ${response.status}: ${await response.text()} `
          + `(remote actor document fetches=${actorDocumentFetches})`,
        );
      }
    }
  });

  await Promise.all(workers);
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    ok: true,
    marker,
    invalidMarker,
    invalidSignature,
    count,
    actorUri,
    sidecarInbox,
    actorDocumentFetches,
    signatureImplementation: '@fedify/fedify signRequest draft-cavage-http-signatures-12 minimal signed headers',
    elapsedMs,
    acceptedPerSec: count / (elapsedMs / 1000),
    maxPostLatencyMs: Math.max(...latencies),
  }, null, 2));
} finally {
  await app.close();
}
