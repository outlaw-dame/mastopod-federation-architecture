#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const [evidencePath, originPath, targetHost, outputPath] = process.argv.slice(2);
if (!evidencePath || !originPath || !targetHost) {
  console.error('usage: assert-real-signing-call.mjs <signing-api.jsonl> <external-origin.json> <target-host> [output.json]');
  process.exit(2);
}

const origin = JSON.parse(fs.readFileSync(originPath, 'utf8'));
if (origin.ok !== true || origin.mode !== 'external' || origin.durableHandoffQueued !== true || origin.nativeRemotePostSuppressed !== true) {
  console.error('external origin evidence does not prove the fail-closed sidecar handoff invariants');
  process.exit(1);
}
const { actorUri, activityId, remoteActorUri } = origin;
if (![actorUri, activityId, remoteActorUri].every(value => typeof value === 'string' && value.length > 0)) {
  console.error('external origin evidence is missing actorUri, activityId, or remoteActorUri');
  process.exit(1);
}

const rows = fs.existsSync(evidencePath)
  ? fs.readFileSync(evidencePath, 'utf8').split(/\n/u).filter(Boolean).map(line => JSON.parse(line))
  : [];
const matches = [];

for (const row of rows) {
  if (row.schema !== 'ap.real-signing-api-call.v1') continue;
  if (row.path !== '/api/internal/signatures/batch' || row.responseStatus !== 200) continue;
  if (!Array.isArray(row.request?.requests) || !Array.isArray(row.response?.results)) continue;

  row.request.requests.forEach((requestItem, index) => {
    if (requestItem.actorUri !== actorUri) return;
    if (requestItem.method !== 'POST' || requestItem.profile !== 'ap_post_v1') return;
    if (requestItem.target?.host !== targetHost) return;
    if (typeof requestItem.target?.path !== 'string' || !requestItem.target.path.startsWith('/')) return;
    if (requestItem.body?.encoding !== 'utf8' || typeof requestItem.body?.bytes !== 'string') return;
    let activity;
    try { activity = JSON.parse(requestItem.body.bytes); } catch { return; }
    if (activity?.type !== 'Follow' || activity?.id !== activityId || activity?.actor !== actorUri || activity?.object !== remoteActorUri) return;
    const result = row.response.results[index];
    if (!result || result.ok !== true || result.requestId !== requestItem.requestId) return;
    const keyId = result.meta?.keyId;
    const signature = result.outHeaders?.Signature;
    const digest = result.outHeaders?.Digest;
    const bodySha256Base64 = createHash('sha256').update(requestItem.body.bytes, 'utf8').digest('base64');
    if (typeof keyId !== 'string' || !keyId.startsWith(`${actorUri}#`)) return;
    if (typeof signature !== 'string' || !signature.includes(`keyId="${keyId}"`)) return;
    if (digest !== `SHA-256=${bodySha256Base64}` || result.meta?.bodySha256Base64 !== bodySha256Base64) return;
    matches.push({
      requestId: requestItem.requestId,
      actorUri,
      targetHost,
      targetPath: requestItem.target.path,
      activityId,
      bodySha256Base64,
      keyId,
      signedHeaders: result.meta?.signedHeaders || null
    });
  });
}

if (matches.length === 0) {
  console.error(`no exact successful ActivityPods signing result for actor=${actorUri} targetHost=${targetHost}`);
  process.exit(1);
}

const evidence = {
  schema: 'activitypods.activitypub.real-signing-proof.v1',
  ok: true,
  actorUri,
  targetHost,
  activityId,
  remoteActorUri,
  deliveredInboxPaths: [...new Set(matches.map(match => match.targetPath))],
  bodySha256Base64: [...new Set(matches.map(match => match.bodySha256Base64))],
  successfulSigningCalls: matches.length,
  signerKeyIds: [...new Set(matches.map(match => match.keyId))],
  requestIds: [...new Set(matches.map(match => match.requestId))]
};

const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) fs.writeFileSync(outputPath, json);
process.stdout.write(json);
