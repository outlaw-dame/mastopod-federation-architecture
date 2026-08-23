#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const baseUrl = process.env.AP_SERVICE_PROOF_SIDECAR_URL || 'http://127.0.0.1:8080';
const token = process.env.SIDECAR_TOKEN || '';
const actorUri = process.env.AP_SERVICE_PROOF_ACTOR_URI || 'https://sidecar/users/relay';
const remoteActorUri = process.env.AP_SERVICE_PROOF_REMOTE_ACTOR_URI || 'https://mastodon/users/interop';
const inboxUrl = process.env.AP_SERVICE_PROOF_REMOTE_INBOX || 'https://mastodon/inbox';
const outputPath = process.env.AP_SERVICE_PROOF_OUTPUT_PATH || '';

if (!token) throw new Error('SIDECAR_TOKEN is required');
for (const [label, value] of Object.entries({ baseUrl, actorUri, remoteActorUri, inboxUrl })) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be a credential-free HTTP(S) URL without a fragment`);
  }
}
const actor = new URL(actorUri);
if (actor.pathname !== '/users/relay' || actor.search) {
  throw new Error('service actor proof must use the published /users/relay actor route');
}

const nonce = randomUUID();
const activityId = `${actorUri}/activities/follow-${nonce}`;
const intentId = `ap-service-actor-proof-${nonce}`;
const targetDomain = new URL(inboxUrl).hostname.toLowerCase();
const activity = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: activityId,
  type: 'Follow',
  actor: actorUri,
  object: remoteActorUri,
  to: [remoteActorUri],
};
const payload = {
  actorUri,
  activity,
  remoteTargets: [{
    targetDomain,
    inboxUrl,
    apdmAuthority: {
      schema: 'ap.delivery-plan.v1',
      intentId,
    },
  }],
  meta: {
    deliveryPlanSchema: 'ap.delivery-plan.v1',
    deliveryPlanIntentId: intentId,
  },
};

const response = await fetch(new URL('/webhook/outbox', baseUrl), {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-apdm-intent-id': intentId,
  },
  body: JSON.stringify(payload),
});
const responseText = await response.text();
if (response.status !== 202) {
  throw new Error(`sidecar service actor handoff failed with HTTP ${response.status}: ${responseText.slice(0, 512)}`);
}

const evidence = {
  schema: 'activitypods.activitypub.sidecar-service-actor-proof.v1',
  ok: true,
  mode: 'sidecar_service',
  actorUri,
  activityId,
  remoteActorUri,
  targetDomain,
  inboxUrl,
  intentId,
  handoffStatus: response.status,
};
const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) fs.writeFileSync(outputPath, json);
process.stdout.write(json);
