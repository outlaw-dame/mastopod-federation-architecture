import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const origin = 'https://provider.paper.example.org:8443';
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${origin}/_staging/ready`, { signal: AbortSignal.timeout(3000) });
    if (response.ok && (await response.json()).brokerStarted === true) { ready = true; break; }
  } catch { /* Bounded read-only readiness polling; never replay signup here. */ }
  await setTimeout(2000);
}
assert.ok(ready, 'Provider never reached HTTPS configuration readiness');
const config = await fetch(`${origin}/.well-known/config.js`, { signal: AbortSignal.timeout(5000) });
assert.equal(config.status, 200);
assert.ok((await config.text()).includes(origin));
const page = await fetch('https://login.paper.example.org:8443/', { signal: AbortSignal.timeout(5000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /<div id="root"><\/div>/);
// Verify the public OIDC metadata used by actual apps over this profile's
// CA-trusted HTTPS ingress. Discovery and JWKS are public, not owner sign-in.
async function readBoundedJson(response, label) {
  assert.equal(response.status, 200, `${label}: unexpected HTTP ${response.status}`);
  // RFC 7517 JWKS endpoints legitimately use application/jwk-set+json.
  const contentType = response.headers.get('content-type') || '';
  const expected = label === 'OIDC signing keys'
    ? /^application\/(?:json|jwk-set\+json)(?:;|$)/iu
    : /^application\/json(?:;|$)/iu;
  assert.match(contentType, expected);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= 65536, `${label}: response exceeds bound`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const discovery = await readBoundedJson(await fetch(`${origin}/.well-known/openid-configuration`, {
  redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' }
}), 'OIDC discovery');
assert.equal(discovery.issuer, origin + '/');
for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
  assert.equal(new URL(discovery[key]).origin, origin, `OIDC ${key} must stay on this provider`);
}
const jwks = await readBoundedJson(await fetch(discovery.jwks_uri, {
  redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' }
}), 'OIDC signing keys');
assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.length <= 16);
for (const key of jwks.keys) {
  assert.ok(['RSA', 'EC', 'OKP'].includes(key.kty), 'OIDC must publish asymmetric signing keys');
  for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
    assert.equal(Object.hasOwn(key, privateField), false, 'OIDC JWKS must not disclose private material');
  }
}
// The JWKS is public; hash a canonical representation so key order and JSON
// property order cannot manufacture a false restart failure. A change in a
// signing key or its public metadata is still detectable.
const normalizedJwks = jwks.keys.map(key => Object.fromEntries(
  Object.keys(key).sort().map(name => [name, key[name]])
)).sort((left, right) => {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
});
const jwksFingerprint = createHash('sha256')
  .update(JSON.stringify(normalizedJwks)).digest('hex');

// These are real provider HTTPS responses, not mocked actions. With no
// authenticated cookie, owner grant details and one-use revocation challenges
// must never be disclosed. A malicious cross-origin POST is rejected before
// any consent lookup or mutation. No account is created in this gate.
const unauthGrant = await fetch(
  `${origin}/oauth/owner/grant?client_id=${encodeURIComponent('https://client.paper.example.org/metadata.json')}`, {
    redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{accept:'application/json'}
  });
assert.equal(unauthGrant.status,401,'Unauthenticated owner grant inspection must deny');
assert.match(unauthGrant.headers.get('cache-control')||'',/no-store/iu);
const crossOriginRevoke = await fetch(origin+'/oauth/owner/grant/revoke', {
  method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
  headers:{'content-type':'application/json',origin:'https://attacker.example.org'},
  body:'{}'
});
assert.equal(crossOriginRevoke.status,403,'Cross-origin owner revocation must deny');
assert.match(crossOriginRevoke.headers.get('cache-control')||'',/no-store/iu);
const unauthRevoke = await fetch(origin+'/oauth/owner/grant/revoke', {
  method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
  headers:{'content-type':'application/json',origin},
  body:'{}'
});
assert.equal(unauthRevoke.status,401,'Owner revocation without a browser session must deny');
console.log('PASS: owner grant HTTPS routes deny unauthenticated and cross-origin requests.');

// Neither of the provider's two public account-creation entry points may
// create an identity in this production-mode staging profile. Probe both on
// initial startup and after the storage/provider restart, before sending any
// real account details or irreversible provisioning request.
for (const [path, type] of [
  ['/api/accounts/create', 'UNIFIED_ACCOUNT_RELEASE_GATE_CLOSED'],
  ['/auth/signup', 'ATPROTO_PDS_REPOSITORY_NOT_READY']
]) {
  const denied = await fetch(origin + path, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(denied.status, 503, `Unexpected HTTP ${denied.status} on ${path}`);
  const error = await denied.json();
  assert.equal(error.type, type, `Unexpected account release gate on ${path}`);
}
console.log('PASS: actual provider and frontend reachable over verified HTTPS; unified signup release gate remains CLOSED.');
// Public-key fingerprint only; never emit secrets, identity tokens or JWK
// private parameters. CI compares this after the same isolated volumes restart.
console.log('STAGING_OIDC_JWKS_SHA256=' + jwksFingerprint);
