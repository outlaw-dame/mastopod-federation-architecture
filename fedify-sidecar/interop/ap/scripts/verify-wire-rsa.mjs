import { createPublicKey, verify } from 'node:crypto';

export function verifyWireRsa(wire, signature, actor) {
  if (actor.id && actor['@id'] && actor.id !== actor['@id']) throw new Error('conflicting published actor identities');
  if ((actor.id ?? actor['@id']) !== wire.actorUri) throw new Error('published actor identity mismatch');
  const keys = Array.isArray(actor.publicKey) ? actor.publicKey : [actor.publicKey];
  const matches = keys.filter(key => key?.id === signature.keyId && key?.owner === wire.actorUri);
  if (matches.length !== 1) throw new Error('published signing key ownership is ambiguous or incorrect');
  const key = createPublicKey(matches[0].publicKeyPem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('published key must be RSA with at least 2048 bits');
  }
  if (!/^\/[\x21-\x7e]*$/.test(wire.path) || /[\r\n]/.test(wire.host + wire.date + wire.digest)) {
    throw new Error('wire signed headers contain invalid characters');
  }
  const encoded = signature.signature;
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
    throw new Error('signature bytes are not canonical base64');
  }
  const input = `(request-target): post ${wire.path}\nhost: ${wire.host}\ndate: ${wire.date}\ndigest: ${wire.digest}`;
  if (!verify('RSA-SHA256', Buffer.from(input), key, Buffer.from(encoded, 'base64'))) {
    throw new Error('wire RSA signature does not verify against the published actor key');
  }
  return true;
}

export async function fetchPublishedActor(actorUri) {
  const url = new URL(actorUri);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('published actor must have a credential-free HTTPS authority');
  }
  const response = await fetch(url, {
    headers: { accept: 'application/activity+json' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`published actor fetch failed: ${response.status}`);
  if (!/^application\/(activity\+json|ld\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('published actor response has an unsupported media type');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('published actor exceeds evidence byte bound');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
