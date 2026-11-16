import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const origin = 'https://provider.paper.test:8443';
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
const page = await fetch('https://login.paper.test:8443/', { signal: AbortSignal.timeout(5000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /<div id="root"><\/div>/);
const denied = await fetch(`${origin}/api/accounts/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
});
const error = await denied.json();
assert.equal(denied.status, 503, `Unexpected signup HTTP ${denied.status}, type ${String(error.type).slice(0,100)}`);
assert.equal(error.type, 'UNIFIED_ACCOUNT_RELEASE_GATE_CLOSED');
console.log('PASS: actual provider and frontend reachable over verified HTTPS; unified signup release gate remains CLOSED.');
