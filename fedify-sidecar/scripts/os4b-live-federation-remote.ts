import Fastify from 'fastify';
import { fetchKeyDetailed, signRequest, verifyRequestDetailed } from '@fedify/fedify';
import { CryptographicKey } from '@fedify/fedify/vocab';
import { request as undiciRequest } from 'undici';

const host = process.env.OS4B_REMOTE_HOST ?? '127.0.0.1';
const port = Number(process.env.OS4B_REMOTE_PORT ?? 18181);
const publicHost = process.env.OS4B_REMOTE_PUBLIC_HOST ?? host;
const publicPort = Number(process.env.OS4B_REMOTE_PUBLIC_PORT ?? port);
const sidecarInbox = process.env.OS4B_SIDECAR_INBOX ?? 'http://127.0.0.1:18080/inbox';
const sidecarHostHeader = process.env.OS4B_SIDECAR_HOST_HEADER ?? 'local.test';
const count = Number(process.env.OS4B_FEDERATION_COUNT ?? 240);
const concurrency = Math.max(1, Number(process.env.OS4B_FEDERATION_CONCURRENCY ?? 24));
const marker = process.env.OS4B_FEDERATION_MARKER ?? `os4b-live-${Date.now()}`;
const warmupMarker = `${marker}-valid-warmup`;
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
const actorDocument = {
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
};
const app = Fastify({ logger: false });
let actorDocumentFetches = 0;

app.get('/health', async () => ({ ok: true }));
app.get('/users/remote', async (_request, reply) => {
  actorDocumentFetches += 1;
  reply.type('application/activity+json').send(actorDocument);
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

async function createSignedRequest(body: string): Promise<Request> {
  // Sign the logical public request authority, not the loopback socket used by
  // this isolated CI fixture. The bridge receives matching forwarded metadata
  // below and therefore reconstructs this same Request URL before verification.
  const visibleUrl = new URL(sidecarInbox);
  visibleUrl.hostname = sidecarHostHeader;
  visibleUrl.port = '';
  const bodyBytes = Buffer.from(body, 'utf8');
  const unsigned = new Request(visibleUrl, {
    method: 'POST',
    headers: { host: sidecarHostHeader },
    body: bodyBytes,
  });
  return await signRequest(unsigned, keyPair.privateKey, new URL(keyId), {
    spec: 'draft-cavage-http-signatures-12',
    body: bodyBytes,
  });
}

async function createSignedHeaders(body: string): Promise<Record<string, string>> {
  const signed = await createSignedRequest(body);
  const headers: Record<string, string> = {};
  signed.headers.forEach((value, name) => { headers[name] = value; });
  headers.host = sidecarHostHeader;
  headers['content-type'] = 'application/activity+json';
  headers.accept = 'application/activity+json';
  // These are deliberately appended after signing. They model the reverse
  // proxy metadata the Fastify bridge already consumes and make its Web
  // Request origin exactly match the logical request that Fedify signed.
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = sidecarHostHeader;
  return headers;
}

const localActorDocumentLoader = async (resource: string) => ({
  contextUrl: null,
  document: actorDocument,
  documentUrl: resource,
});

async function runFedifySelfCheck() {
  const body = JSON.stringify(buildActivity(-2, `${marker}-self-check`));
  const signed = await createSignedRequest(body);
  const fetched = await fetchKeyDetailed(new URL(keyId), CryptographicKey, {
    documentLoader: localActorDocumentLoader,
  });
  const verification = await verifyRequestDetailed(signed.clone(), {
    documentLoader: localActorDocumentLoader,
    spec: 'draft-cavage-http-signatures-12',
  });
  const result = {
    keyParsed: fetched.key != null,
    keyCached: fetched.cached,
    keyFetchError: fetched.fetchError == null
      ? null
      : ('status' in fetched.fetchError
        ? { status: fetched.fetchError.status }
        : { name: fetched.fetchError.error.name, message: fetched.fetchError.error.message }),
    verified: verification.verified,
    verificationReason: verification.verified
      ? null
      : {
          type: verification.reason.type,
          ...('keyId' in verification.reason
            ? { keyId: verification.reason.keyId?.href ?? null }
            : {}),
        },
    signedHeaders: signed.headers.get('signature'),
    digest: signed.headers.get('digest'),
    host: signed.headers.get('host'),
    url: signed.url,
  };
  if (!result.keyParsed || !result.verified) {
    throw new Error(`Fedify fixture self-check failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function postSigned(body: string, headers: Record<string, string>) {
  // Use Undici's low-level request path so Host and the signed UTF-8 body bytes
  // are transmitted verbatim while the TCP connection still targets loopback.
  const response = await undiciRequest(sidecarInbox, {
    method: 'POST',
    headers,
    body: Buffer.from(body, 'utf8'),
  });
  return { status: response.statusCode, body: await response.body.text() };
}

async function sendValidWarmup() {
  const body = JSON.stringify(buildActivity(-3, warmupMarker));
  const response = await postSigned(body, await createSignedHeaders(body));
  if (response.status !== 202) {
    throw new Error(
      `valid warm-up returned ${response.status}: ${response.body} `
      + `(remote actor document fetches=${actorDocumentFetches})`,
    );
  }
  return { status: response.status, actorDocumentFetches };
}

async function sendInvalidSignatureControl() {
  const body = JSON.stringify(buildActivity(-1, invalidMarker));
  const headers = await createSignedHeaders(body);
  const signatureName = Object.keys(headers).find((name) => name.toLowerCase() === 'signature');
  if (!signatureName) throw new Error('Fedify signRequest did not emit Signature header for Cavage request');
  headers[signatureName] = `${headers[signatureName]!.slice(0, -8)}INVALID!`;
  const response = await postSigned(body, headers);
  if (response.status >= 200 && response.status < 300) {
    throw new Error(`invalid-signature control was accepted with ${response.status}: ${response.body}`);
  }
  return { status: response.status, body: response.body.slice(0, 512) };
}

const startedAt = Date.now();
let next = 0;
const latencies: number[] = [];

try {
  const fedifySelfCheck = await runFedifySelfCheck();
  const validWarmup = await sendValidWarmup();
  const invalidSignature = await sendInvalidSignatureControl();

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= count) return;
      const activity = buildActivity(i);
      const body = JSON.stringify(activity);
      const requestStartedAt = Date.now();
      const response = await postSigned(body, await createSignedHeaders(body));
      latencies.push(Date.now() - requestStartedAt);
      if (response.status !== 202) {
        throw new Error(
          `federation POST ${i} returned ${response.status}: ${response.body} `
          + `(remote actor document fetches=${actorDocumentFetches}; `
          + `selfCheck=${JSON.stringify(fedifySelfCheck)}; `
          + `validWarmup=${JSON.stringify(validWarmup)})`,
        );
      }
    }
  });

  await Promise.all(workers);
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    ok: true,
    marker,
    warmupMarker,
    invalidMarker,
    validWarmup,
    invalidSignature,
    fedifySelfCheck,
    count,
    actorUri,
    sidecarInbox,
    actorDocumentFetches,
    signatureImplementation: '@fedify/fedify signRequest draft-cavage-http-signatures-12 minimal signed headers',
    wireTransport: 'undici.request exact Host/body with forwarded logical origin',
    elapsedMs,
    acceptedPerSec: count / (elapsedMs / 1000),
    maxPostLatencyMs: Math.max(...latencies),
  }, null, 2));
} finally {
  await app.close();
}
