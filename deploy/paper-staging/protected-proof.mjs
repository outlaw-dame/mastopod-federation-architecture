// Disposable protected Jena admission proof. Never part of the provider's runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.env.NODE_ENV !== 'test' ||
    process.env.PAPER_STAGING_PROTECTED_PROOF !== 'confirmed' ||
    !['prepare', 'verify'].includes(process.argv[2])) {
  throw new Error('Protected Jena storage proof requires explicit disposable scope');
}
const phase = process.argv[2];
const origin = 'http://protected-fuseki:3030';
const creds = JSON.parse(readFileSync('/run/protected-access.json', 'utf8'));
const roleNames = {
  provisioner: 'paper-protected-provisioner',
  projector: 'paper-protected-projector',
  attestor: 'paper-protected-attestor',
  ordinary: 'admin'
};
for (const [name, username] of Object.entries(roleNames)) {
  const user = creds[name];
  assert.equal(user?.username, username);
  assert.match(user?.password || '', /^[a-f0-9]{64}$/u);
}
const subject = '<urn:paper:protected-staging:binding>';
const predicate = '<urn:paper:protected-staging:status>';
const triple = subject + ' ' + predicate + ' "signed-baseline" .';
const update = 'INSERT DATA { ' + triple + ' }';
const deleteProtected = 'DELETE WHERE { ' + subject + ' ' + predicate + ' ?v }';

async function call(path, role, { method = 'POST', body, type, accept } = {}) {
  const authorization = role === null ? undefined :
    'Basic ' + Buffer.from(creds[role].username + ':' + creds[role].password).toString('base64');
  const response = await fetch(origin + path, {
    method, redirect: 'manual',
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(type ? { 'content-type': type } : {}),
      ...(accept ? { accept } : {})
    },
    body,
    signal: AbortSignal.timeout(8000)
  });
  const chunks = [];
  let bytes = 0;
  // Apache Jena's successful SPARQL updates commonly return 204 with no
  // response stream. Do not mistake an absent body for a failed admission.
  if (response.body) {
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        assert.ok(bytes <= 32768, 'Protected Jena HTTP response too large');
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      await response.body.cancel().catch(() => {});
    }
  }
  return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
}
function ok(reply, label) {
  assert.ok(reply.status >= 200 && reply.status < 300,
    label + ' must succeed via authorized storage role; HTTP ' + reply.status);
}
function no(reply, label) {
  assert.ok(reply.status === 401 || reply.status === 403,
    label + ' must be rejected at storage credential boundary; HTTP ' + reply.status);
}
async function read(role) {
  const reply = await call('/protected-proof/query', role, {
    type: 'application/sparql-query', accept: 'application/sparql-results+json',
    body: 'SELECT ?value WHERE { ' + subject + ' ' + predicate + ' ?value }'
  });
  ok(reply, role + ' protected query');
  const result = JSON.parse(reply.body);
  return result.results?.bindings?.map(row => row.value?.value);
}
async function ready() {
  for (let i = 0; i < 40; i++) {
    try {
      const reply = await call('/$/ping', null, { method: 'GET' });
      if (reply.status === 200) return;
    } catch { /* Short-lived startup; no mutations are retried. */ }
    await sleep(1000);
  }
  throw new Error('Protected Jena service did not become ready');
}
await ready();
if (phase === 'prepare') {
  const created = await call('/$/datasets', 'provisioner', {
    type: 'application/x-www-form-urlencoded',
    body: 'dbName=protected-proof&dbType=tdb2'
  });
  ok(created, 'Protected dataset creation');
  ok(await call('/protected-proof/update', 'projector', {
    type: 'application/sparql-update', body: update
  }), 'Projection writer');
}
assert.deepEqual(await read('attestor'), ['signed-baseline']);
assert.deepEqual(await read('projector'), ['signed-baseline']);
const cases = [
  ['ordinary protected query', '/protected-proof/query', 'ordinary',
    { type: 'application/sparql-query', body: 'ASK {}' }],
  ['ordinary protected UPDATE', '/protected-proof/update', 'ordinary',
    { type: 'application/sparql-update', body: deleteProtected }],
  ['ordinary protected Graph Store PUT', '/protected-proof/data', 'ordinary',
    { method: 'PUT', type: 'text/turtle', body: triple }],
  ['ordinary protected Graph Store DELETE', '/protected-proof/data', 'ordinary',
    { method: 'DELETE' }],
  ['ordinary protected dataset root', '/protected-proof', 'ordinary',
    { type: 'application/sparql-update', body: deleteProtected }],
  ['ordinary Fuseki dataset administration', '/$/datasets', 'ordinary',
    { type: 'application/x-www-form-urlencoded',
      body: 'dbName=forged-proof&dbType=tdb2' }],
  ['ordinary Fuseki dataset destroy', '/$/datasets/protected-proof', 'ordinary',
    { method: 'DELETE' }],
  ['ordinary Fuseki backup', '/$/backup/protected-proof', 'ordinary',
    { method: 'POST' }],
  ['anonymous protected UPDATE', '/protected-proof/update', null,
    { type: 'application/sparql-update', body: deleteProtected }],
  ['attestor protected UPDATE', '/protected-proof/update', 'attestor',
    { type: 'application/sparql-update', body: deleteProtected }],
  ['attestor protected Graph Store DELETE', '/protected-proof/data', 'attestor',
    { method: 'DELETE' }],
  ['attestor Fuseki administration', '/$/datasets', 'attestor',
    { type: 'application/x-www-form-urlencoded',
      body: 'dbName=forged-proof&dbType=tdb2' }],
  ['projector Fuseki administration', '/$/datasets', 'projector',
    { type: 'application/x-www-form-urlencoded',
      body: 'dbName=forged-proof&dbType=tdb2' }]
];
for (const [label, path, role, args] of cases) {
  no(await call(path, role, args), label);
}
assert.deepEqual(await read('attestor'), ['signed-baseline'],
  'Untrusted writes must not alter protected RDF');
console.log('PASS: independently credentialed protected Jena, ' + cases.length +
  ' hostile access checks, authorized projection/readback, durable RDF phase=' + phase +
  '; production signup release=CLOSED.');
