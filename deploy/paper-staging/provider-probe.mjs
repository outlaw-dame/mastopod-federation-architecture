import assert from 'node:assert/strict';
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

const denied = await fetch(`${origin}/api/accounts/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
});
const error = await denied.json();
assert.equal(denied.status, 503, `Unexpected signup HTTP ${denied.status}, type ${String(error.type).slice(0,100)}`);
assert.equal(error.type, 'UNIFIED_ACCOUNT_RELEASE_GATE_CLOSED');
console.log('PASS: actual provider and frontend reachable over verified HTTPS; unified signup release gate remains CLOSED.');
