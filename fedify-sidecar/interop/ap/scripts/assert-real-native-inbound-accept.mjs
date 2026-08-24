#!/usr/bin/env node
import fs from 'node:fs';

const [evidencePath, originPath, targetHost, outputPath] = process.argv.slice(2);
if (!evidencePath || !originPath || !targetHost || !outputPath) {
  console.error('usage: assert-real-native-inbound-accept.mjs <inbound.jsonl> <origin.json> <target-host> <output.json>');
  process.exit(2);
}

const maxBytes = 16 * 1024 * 1024;
if (!fs.existsSync(evidencePath) || fs.statSync(evidencePath).size > maxBytes) fail('native inbound evidence is missing or exceeds 16 MiB');
const origin = JSON.parse(fs.readFileSync(originPath, 'utf8'));
if (origin?.ok !== true || origin.mode !== 'native') fail('origin is not a successful native proof');
for (const key of ['activityId', 'actorUri', 'remoteActorUri']) {
  if (typeof origin[key] !== 'string' || origin[key].length === 0) fail(`origin is missing ${key}`);
}

const rows = fs.readFileSync(evidencePath, 'utf8').split(/\n/u).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); }
  catch { fail(`native inbound evidence line ${index + 1} is not valid JSON`); }
});
const matches = rows.filter(row => {
  if (row?.schema !== 'ap.real-inbound-api-call.v1' || row.method !== 'POST') return false;
  if (!Number.isInteger(row.responseStatus) || row.responseStatus < 200 || row.responseStatus > 299) return false;
  if (!['Accept', 'https://www.w3.org/ns/activitystreams#Accept'].includes(row.activityType)) return false;
  if (!['Follow', 'https://www.w3.org/ns/activitystreams#Follow'].includes(row.objectType)) return false;
  if (row.objectId !== origin.activityId || row.objectActorUri !== origin.actorUri || row.objectTargetUri !== origin.remoteActorUri) return false;
  try { return new URL(row.actorUri).hostname === targetHost; } catch { return false; }
});
if (matches.length < 1) fail(`no successful native ActivityPods receipt correlated the exact Follow ${origin.activityId}`);
const semanticKeys = new Set(matches.map(row => JSON.stringify([
  row.activityId, row.actorUri, row.objectId, row.objectActorUri, row.objectTargetUri, row.bodySha256Base64,
])));
if (semanticKeys.size !== 1) fail('conflicting native Accept receipts matched the same Follow');
const match = matches[0];
if (typeof match.activityId !== 'string' || match.activityId.length === 0) fail('matching native Accept has no activity id');
if (!Number.isInteger(match.bodyBytes) || match.bodyBytes < 1 || typeof match.bodySha256Base64 !== 'string') {
  fail('matching native Accept has incomplete bounded body evidence');
}

const result = {
  schema: 'activitypods.activitypub.real-native-inbound-accept.v1',
  ok: true,
  actorUri: origin.actorUri,
  followActivityId: origin.activityId,
  remoteActorUri: origin.remoteActorUri,
  acceptActivityId: match.activityId,
  acceptedByActivityPods: true,
  receiptCount: matches.length,
  bodySha256Base64: match.bodySha256Base64,
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
