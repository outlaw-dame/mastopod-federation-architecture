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

// Browser login and authorization are hosted by this provider; callers
// cannot use a third-party form to log an unrelated user into a session.
// These are real HTTPS requests, with harmless nonexistent credentials.
const bogusLogin=new URLSearchParams({
  username:'no-such-user@invalid.example',password:'disposable-invalid'
}).toString();
async function browserPost(path,headers,body) {
  return fetch(origin+path, {
    method:'POST',redirect:'error',cache:'no-store',
    headers,body,signal:AbortSignal.timeout(5000)
  });
}
for (const [label,headers] of [
  ['cross-site Origin', {
    origin:'https://attacker.example.org',
    'content-type':'application/x-www-form-urlencoded'
  }],
  ['missing Origin',{'content-type':'application/x-www-form-urlencoded'}],
  ['cross-site Fetch Metadata',{
    origin,'content-type':'application/x-www-form-urlencoded',
    'sec-fetch-site':'cross-site'
  }],
  ['invalid form encoding',{origin,'content-type':'text/plain'}]
]) {
  const refused=await browserPost('/oauth/session/login',headers,bogusLogin);
  assert.equal(refused.status,403,'Browser login must deny '+label);
  assert.match(refused.headers.get('cache-control')||'',/no-store/iu);
  assert.equal(refused.headers.get('set-cookie'),null,
    'Rejected login must never issue a browser session');
}
const normalBadCredentials=await browserPost('/oauth/session/login',{
  origin,'content-type':'application/x-www-form-urlencoded',
  'sec-fetch-site':'same-origin'
},bogusLogin);
assert.equal(normalBadCredentials.status,401,
  'Correct same-origin form must reach password verification and deny unknown account');
assert.equal(normalBadCredentials.headers.get('set-cookie'),null,
  'Unverified account may not receive a signed session cookie');

const thirdPartyLogout=await browserPost('/oauth/session/logout',{
  origin:'https://attacker.example.org'
});
assert.equal(thirdPartyLogout.status,403,
  'Cross-origin forced logout must not delete a browser session');
assert.equal(thirdPartyLogout.headers.get('set-cookie'),null);
const ownerLogout=await browserPost('/oauth/session/logout',{
  origin,'sec-fetch-site':'same-origin'
});
assert.equal(ownerLogout.status,200,
  'Bodyless same-origin logout must work without Content-Type');
assert.deepEqual(await ownerLogout.json(),{ok:true});
assert.match(ownerLogout.headers.get('set-cookie')||'',/Max-Age=0/iu);
const thirdPartyApproval=await browserPost('/oauth/authorize',{
  origin:'https://attacker.example.org',
  'content-type':'application/x-www-form-urlencoded',
  cookie:'oauth_csrf=invalid'
},'decision=approve&request_uri=invalid&consent_challenge=invalid');
assert.equal(thirdPartyApproval.status,403,
  'Cross-origin OAuth consent attempt must reject before PAR or account access');
assert.equal(thirdPartyApproval.headers.get('location'),null);
console.log('PASS: real HTTPS origin enforcement for login, consent and logout; same-origin password rejection and bodyless logout.');

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
