import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// Plain Node module used by the real CLI assertion.
// @ts-expect-error interop proof scripts have no TypeScript declarations
import { verifyWireRsa } from '../../../interop/ap/scripts/verify-wire-rsa.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wire = { actorUri: 'https://activitypods.test/alice', host: 'mastodon', path: '/inbox',
  date: 'Sun, 23 Aug 2026 12:00:00 GMT', digest: 'SHA-256=synthetic-unit-test' };
const keyId = `${wire.actorUri}#main-key`;
const signature = { keyId, signature: sign('RSA-SHA256', Buffer.from(
  `(request-target): post ${wire.path}\nhost: ${wire.host}\ndate: ${wire.date}\ndigest: ${wire.digest}`
), privateKey).toString('base64') };
const actor = { id: wire.actorUri, publicKey: { id: keyId, owner: wire.actorUri,
  publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() } };

describe('independent wire RSA verification', () => {
  it('verifies real RSA bytes against the exact published owner', () => {
    expect(verifyWireRsa(wire, signature, actor)).toBe(true);
  });
  it.each(['host', 'path', 'date', 'digest'] as const)('rejects tampered %s', field => {
    expect(() => verifyWireRsa({ ...wire, [field]: wire[field] + 'x' }, signature, actor)).toThrow();
  });
  it('rejects a different published key even when the key ID matches', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(() => verifyWireRsa(wire, signature, { ...actor, publicKey: { ...actor.publicKey,
      publicKeyPem: other.export({ type: 'spki', format: 'pem' }).toString() } })).toThrow();
  });
  it('rejects a key belonging to another actor', () => {
    expect(() => verifyWireRsa(wire, signature, { ...actor, publicKey: { ...actor.publicKey,
      owner: 'https://evil.test/actor' } })).toThrow();
  });
});
