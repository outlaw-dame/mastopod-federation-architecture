import fs from 'node:fs';

function replaceOnce(path, before, after) {
  let text = fs.readFileSync(path, 'utf8');
  if (!text.includes(before)) {
    throw new Error(`Expected patch anchor not found in ${path}: ${before.slice(0, 120)}`);
  }
  text = text.replace(before, after);
  fs.writeFileSync(path, text);
}

replaceOnce(
  'fedify-sidecar/src/delivery/outbound-worker.ts',
  'import { request } from "undici";\nimport { isIP } from "node:net";',
  'import { isIP } from "node:net";\nimport { secureActivityPubRequest } from "../security/activitypub-egress-policy.js";'
);
replaceOnce(
  'fedify-sidecar/src/delivery/outbound-worker.ts',
  'const response = await request(job.targetInbox, {',
  'const response = await secureActivityPubRequest(job.targetInbox, {'
);

replaceOnce(
  'fedify-sidecar/src/federation/FedifyFederationAdapter.ts',
  'import { request } from "undici";',
  'import { secureActivityPubRequest } from "../security/activitypub-egress-policy.js";'
);
replaceOnce(
  'fedify-sidecar/src/federation/FedifyFederationAdapter.ts',
  '  targetUrl.hash = "";\n  return targetUrl;',
  '  if (targetUrl.hash) return null;\n  return targetUrl;'
);
replaceOnce(
  'fedify-sidecar/src/federation/FedifyFederationAdapter.ts',
  'const response = await request(targetUrl, {',
  'const response = await secureActivityPubRequest(targetUrl, {'
);
replaceOnce(
  'fedify-sidecar/src/federation/FedifyFederationAdapter.ts',
  'const response = await request(targetUrl, {',
  'const response = await secureActivityPubRequest(targetUrl, {'
);

const fastPath = 'fedify-sidecar/scripts/run-fast-checks.sh';
let fast = fs.readFileSync(fastPath, 'utf8');
const fastAnchor = '  src/delivery/tests/OutboxIntentWorker.test.ts \\\n  src/federation/tests/FedifyFastifyBridge.test.ts \\\n';
const fastReplacement = '  src/delivery/tests/OutboxIntentWorker.test.ts \\\n  src/security/tests/ActivityPubEgressPolicy.test.ts \\\n  src/federation/tests/FedifyFastifyBridge.test.ts \\\n  src/federation/tests/FedifyFederationAdapterOutbound.test.ts \\\n';
if (!fast.includes(fastAnchor)) throw new Error('Fast-check insertion anchor not found');
fast = fast.replace(fastAnchor, fastReplacement);
fs.writeFileSync(fastPath, fast);

console.log('APDM Phase 5 egress wiring patch applied.');
