import fs from 'node:fs';

function patch(path, replacements) {
  let text = fs.readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!text.includes(before)) {
      throw new Error(`Expected patch anchor not found in ${path}: ${before.slice(0, 120)}`);
    }
    text = text.replace(before, after);
  }
  fs.writeFileSync(path, text);
}

patch('fedify-sidecar/src/delivery/outbound-worker.ts', [
  [
    'import { request } from "undici";\nimport { isIP } from "node:net";',
    'import { isIP } from "node:net";\nimport { secureActivityPubRequest } from "../security/activitypub-egress-policy.js";'
  ],
  [
    'const response = await request(job.targetInbox, {',
    'const response = await secureActivityPubRequest(job.targetInbox, {'
  ]
]);

patch('fedify-sidecar/src/federation/FedifyFederationAdapter.ts', [
  [
    'import { request } from "undici";',
    'import { secureActivityPubRequest } from "../security/activitypub-egress-policy.js";'
  ],
  [
    'const response = await request(targetUrl, {',
    'const response = await secureActivityPubRequest(targetUrl, {'
  ],
  [
    'const response = await request(targetUrl, {',
    'const response = await secureActivityPubRequest(targetUrl, {'
  ]
]);

patch('fedify-sidecar/scripts/run-fast-checks.sh', [
  [
    '  src/delivery/tests/OutboxIntentWorker.test.ts \\\n  src/federation/tests/FedifyFastifyBridge.test.ts \\\',
    '  src/delivery/tests/OutboxIntentWorker.test.ts \\\n  src/security/tests/ActivityPubEgressPolicy.test.ts \\\n  src/federation/tests/FedifyFastifyBridge.test.ts \\\'
  ]
]);

console.log('APDM Phase 5 egress wiring patch applied.');
