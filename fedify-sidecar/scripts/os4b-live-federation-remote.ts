import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import Fastify from 'fastify';

const host = process.env.OS4B_REMOTE_HOST ?? '127.0.0.1';
const port = Number(process.env.OS4B_REMOTE_PORT ?? 18181);
const publicHost = process.env.OS4B_REMOTE_PUBLIC_HOST ?? host;
const publicPort = Number(process.env.OS4B_REMOTE_PUBLIC_PORT ?? port);
const sidecarInbox = process.env.OS4B_SIDECAR_INBOX ?? 'http://127.0.0.1:18080/sharedInbox';
const sidecarHostHeader = process.env.OS4B_SIDECAR_HOST_HEADER ?? 'local.test';
const count = Number(process.env.OS4B_FEDERATION_COUNT ?? 240);
const concurrency = Math.max(1, Number(process.env.OS4B_FEDERATION_CONCURRENCY ?? 24));
const marker = process.env.OS4B_FEDERATION_MARKER ?? `os4b-live-${Date.now()}`;
const actorUri = `http://${publicHost}:${publicPort}/users/remote`;
const keyId = `${actorUri}#main-key`;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const app = Fastify({ logger: false });

app.get('/health', async () => ({ ok: true }));
app.get('/users/remote', async (_request, reply) => {
  reply.type('application/activity+json').send({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: actorUri,
    type: 'Person',
    preferredUsername: 'remote',
    inbox: `http://${publicHost}:${publicPort}/users/remote/inbox`,
    publicKey: { id: keyId, owner: actorUri, publicKeyPem },
  });
});

await app.listen({ host, port });

function buildActivity(i: number) {
  const published = new Date(1_750_000_000_000 + i * 1000).toISOString();
  const objectId = `${actorUri}/notes/${marker}-${i}`;
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUri}/activities/${marker}-${i}`,
    type: 'Create',
    actor: actorUri,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: {
      id: objectId,
      type: 'Note',
      attributedTo: actorUri,
      content: `<p>${marker} live federation note ${i} kiwi orbit</p>`,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
    published,
  };
}

function signedHeaders(body: string) {
  const target = new URL(sidecarInbox);
  const date = new Date().toUTCString();
  const digest = `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
  const signingString = [
    `(request-target): post ${target.pathname}${target.search}`,
    `host: ${sidecarHostHeader}`,
    `date: ${date}`,
    `digest: ${digest}`,
    'content-type: application/activity+json',
  ].join('\n');
  const signature = sign('RSA-SHA256', Buffer.from(signingString), createPrivateKey(privateKeyPem)).toString('base64');
  return {
    host: sidecarHostHeader,
    date,
    digest,
    'content-type': 'application/activity+json',
    signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest content-type",signature="${signature}"`,
  };
}

const startedAt = Date.now();
let next = 0;
const latencies: number[] = [];
const workers = Array.from({ length: concurrency }, async () => {
  while (true) {
    const i = next++;
    if (i >= count) return;
    const activity = buildActivity(i);
    const body = JSON.stringify(activity);
    const requestStartedAt = Date.now();
    const response = await fetch(sidecarInbox, { method: 'POST', headers: signedHeaders(body), body });
    latencies.push(Date.now() - requestStartedAt);
    if (response.status !== 202) {
      throw new Error(`federation POST ${i} returned ${response.status}: ${await response.text()}`);
    }
  }
});

try {
  await Promise.all(workers);
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    ok: true,
    marker,
    count,
    actorUri,
    sidecarInbox,
    elapsedMs,
    acceptedPerSec: count / (elapsedMs / 1000),
    maxPostLatencyMs: Math.max(...latencies),
  }, null, 2));
} finally {
  await app.close();
}
