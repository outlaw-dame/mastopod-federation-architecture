#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const [evidencePath, originPath, targetHost, outputPath] = process.argv.slice(2);
if (!evidencePath || !originPath || !targetHost) {
  console.error('usage: assert-real-signing-call.mjs <signing-api.jsonl> <external-origin.json> <target-host> [output.json]');
  process.exit(2);
}

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const EXPECTED_SIGNED_HEADERS = '(request-target) host date digest';

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
const remoteDeliveryTarget = origin.remoteDeliveryTarget;
if (!remoteDeliveryTarget || typeof remoteDeliveryTarget !== 'object' || Array.isArray(remoteDeliveryTarget)) {
  console.error('external origin evidence is missing the authoritative remote delivery target');
  process.exit(1);
}
const targetKeys = Object.keys(remoteDeliveryTarget).sort();
const allowedTargetKeys = ['actorUri', 'deliveryUrl', 'inboxUrl', 'sharedInboxUrl', 'targetDomain'];
if (targetKeys.some(key => !allowedTargetKeys.includes(key))) {
  console.error('external origin remote delivery target contains unsupported fields');
  process.exit(1);
}
if (remoteDeliveryTarget.actorUri !== remoteActorUri) {
  console.error('external origin remote delivery target does not match remoteActorUri');
  process.exit(1);
}

function parseCredentialFreeUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

const inboxUrl = parseCredentialFreeUrl(remoteDeliveryTarget.inboxUrl);
const sharedInboxUrl = remoteDeliveryTarget.sharedInboxUrl === undefined
  ? null
  : parseCredentialFreeUrl(remoteDeliveryTarget.sharedInboxUrl);
const deliveryUrl = parseCredentialFreeUrl(remoteDeliveryTarget.deliveryUrl);
const expectedDeliveryUrl = sharedInboxUrl || inboxUrl;
const requestedTarget = parseCredentialFreeUrl(`https://${targetHost}`);
if (
  !inboxUrl ||
  (remoteDeliveryTarget.sharedInboxUrl !== undefined && !sharedInboxUrl) ||
  !deliveryUrl ||
  !expectedDeliveryUrl ||
  !requestedTarget ||
  requestedTarget.pathname !== '/' ||
  requestedTarget.search !== '' ||
  deliveryUrl.href !== expectedDeliveryUrl.href ||
  deliveryUrl.host !== requestedTarget.host ||
  remoteDeliveryTarget.targetDomain !== deliveryUrl.hostname.toLowerCase()
) {
  console.error('external origin remote delivery target is invalid or does not match the requested host');
  process.exit(1);
}

const actorUrl = parseCredentialFreeUrl(actorUri);
if (!actorUrl || actorUrl.search) {
  console.error('external origin actorUri cannot own a signing key');
  process.exit(1);
}
actorUrl.pathname = `${actorUrl.pathname.replace(/\/$/u, '')}/keys/main`;
const expectedKeyId = actorUrl.toString();

const rows = fs.existsSync(evidencePath)
  ? (() => {
      if (fs.statSync(evidencePath).size > MAX_EVIDENCE_BYTES) {
        throw new Error('signing evidence exceeds the 10 MiB safety limit');
      }
      return fs.readFileSync(evidencePath, 'utf8').split(/\n/u).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); }
        catch { throw new Error(`signing evidence line ${index + 1} is not valid JSON`); }
      });
    })()
  : [];
const matches = [];
const successfulPostCalls = [];

for (const row of rows) {
  if (row.schema !== 'ap.real-signing-api-call.v1') continue;
  if (row.path !== '/api/internal/signatures/batch' || row.responseStatus !== 200) continue;
  if (!Array.isArray(row.request?.requests) || !Array.isArray(row.response?.results)) continue;
  if (row.request.requests.length !== row.response.results.length) continue;
  const requestIds = row.request.requests.map(item => item?.requestId);
  if (requestIds.some(id => typeof id !== 'string' || id.length === 0) || new Set(requestIds).size !== requestIds.length) continue;

  row.request.requests.forEach((requestItem, index) => {
    const result = row.response.results[index];
    if (result?.ok === true && requestItem?.method === 'POST' && /^ap_post_v1(?:_ct)?$/u.test(requestItem?.profile || '')) {
      successfulPostCalls.push({
        requestId: requestItem.requestId,
        actorUri: requestItem.actorUri,
        targetHost: requestItem.target?.host,
        targetPath: requestItem.target?.path
      });
    }
    if (requestItem.actorUri !== actorUri) return;
    if (requestItem.method !== 'POST' || requestItem.profile !== 'ap_post_v1') return;
    if (requestItem.target?.host !== deliveryUrl.host) return;
    if (requestItem.target?.path !== deliveryUrl.pathname) return;
    if ((requestItem.target?.query || '') !== deliveryUrl.search.replace(/^\?/u, '')) return;
    if (requestItem.body?.encoding !== 'utf8' || typeof requestItem.body?.bytes !== 'string') return;
    let activity;
    try { activity = JSON.parse(requestItem.body.bytes); } catch { return; }
    if (activity?.type !== 'Follow' || activity?.id !== activityId || activity?.actor !== actorUri || activity?.object !== remoteActorUri) return;
    if (!result || result.ok !== true || result.requestId !== requestItem.requestId) return;
    const keyId = result.meta?.keyId;
    const signature = result.outHeaders?.Signature;
    const digest = result.outHeaders?.Digest;
    const date = result.outHeaders?.Date;
    const bodySha256Base64 = createHash('sha256').update(requestItem.body.bytes, 'utf8').digest('base64');
    if (keyId !== expectedKeyId) return;
    if (typeof signature !== 'string' || !signature.includes(`keyId="${keyId}"`)) return;
    if (!signature.includes(`headers="${EXPECTED_SIGNED_HEADERS}"`)) return;
    if (typeof date !== 'string' || !Number.isFinite(Date.parse(date))) return;
    if (digest !== `SHA-256=${bodySha256Base64}` || result.meta?.bodySha256Base64 !== bodySha256Base64) return;
    if (result.meta?.signedHeaders !== EXPECTED_SIGNED_HEADERS || result.meta?.algorithm !== 'rsa-sha256') return;
    matches.push({
      requestId: requestItem.requestId,
      actorUri,
      targetHost,
      targetPath: requestItem.target.path,
      activityId,
      bodySha256Base64,
      keyId,
      signedHeaders: result.meta?.signedHeaders || null,
      signature,
      date,
      digest
    });
  });
}

if (matches.length !== 1 || successfulPostCalls.length !== 1) {
  console.error(`expected one plan-bound successful ActivityPods POST signing result for actor=${actorUri} targetHost=${targetHost}; exact=${matches.length} allSuccessfulPosts=${successfulPostCalls.length}`);
  process.exit(1);
}

const match = matches[0];
const evidence = {
  schema: 'activitypods.activitypub.real-signing-proof.v1',
  ok: true,
  actorUri,
  targetHost,
  activityId,
  remoteActorUri,
  remoteDeliveryTarget,
  deliveredInboxPaths: [match.targetPath],
  bodySha256Base64: [match.bodySha256Base64],
  successfulSigningCalls: matches.length,
  allSuccessfulPostSigningCalls: successfulPostCalls.length,
  signerKeyIds: [match.keyId],
  requestIds: [match.requestId],
  signature: match.signature,
  date: match.date,
  digest: match.digest
};

const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) fs.writeFileSync(outputPath, json);
process.stdout.write(json);
