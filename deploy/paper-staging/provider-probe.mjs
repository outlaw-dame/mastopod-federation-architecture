import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const origin = 'https://provider.paper.test:8443';
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${origin}/.well-known/config.js`, { signal: AbortSignal.timeout(3000) });
    if (response.ok && (await response.text()).includes(origin)) { ready = true; break; }
  } catch { /* Bounded read-only readiness polling; never replay signup here. */ }
  await setTimeout(2000);
}
assert.ok(ready, 'Provider never reached HTTPS configuration readiness');
const page = await fetch('https://login.paper.test:8443/', { signal: AbortSignal.timeout(5000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /<div id="root"><\/div>/);
const denied = await fetch(`${origin}/api/accounts/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
});
assert.equal(denied.status, 503);
assert.equal((await denied.json()).type, 'UNIFIED_ACCOUNT_RELEASE_GATE_CLOSED');
console.log('PASS: actual provider and frontend reachable over verified HTTPS; unified signup release gate remains CLOSED.');
