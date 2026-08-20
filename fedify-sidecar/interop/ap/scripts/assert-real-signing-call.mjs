#!/usr/bin/env node
import fs from 'node:fs';

const [evidencePath, actorUri, targetHost, outputPath] = process.argv.slice(2);
if (!evidencePath || !actorUri || !targetHost) {
  console.error('usage: assert-real-signing-call.mjs <signing-api.jsonl> <actor-uri> <target-host> [output.json]');
  process.exit(2);
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
    if (requestItem.target?.host !== targetHost) return;
    const result = row.response.results[index];
    if (!result || result.ok !== true || result.requestId !== requestItem.requestId) return;
    const keyId = result.meta?.keyId;
    const signature = result.outHeaders?.Signature;
    if (typeof keyId !== 'string' || !keyId.startsWith(`${actorUri}#`)) return;
    if (typeof signature !== 'string' || !signature.includes(`keyId="${keyId}"`)) return;
    matches.push({
      requestId: requestItem.requestId,
      actorUri,
      targetHost,
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
  successfulSigningCalls: matches.length,
  signerKeyIds: [...new Set(matches.map(match => match.keyId))],
  requestIds: [...new Set(matches.map(match => match.requestId))]
};

const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) fs.writeFileSync(outputPath, json);
process.stdout.write(json);
