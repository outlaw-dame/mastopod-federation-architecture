#!/usr/bin/env node
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCanonicalRemoteActorUri } from './assert-real-return-accept.mjs';

const DEFAULT_ATTEMPTS = 90;
const DEFAULT_DELAY_MS = 2000;

function parsePositiveInteger(raw, fallback, label, max) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

async function waitForNativeInboundAccept(evidencePath, origin, targetHost) {
  const attempts = parsePositiveInteger(process.env.AP_INTEROP_RETURN_ASSERT_ATTEMPTS, DEFAULT_ATTEMPTS, 'native inbound assertion attempts', 300);
  const delayMs = parsePositiveInteger(process.env.AP_INTEROP_RETURN_ASSERT_DELAY_MS, DEFAULT_DELAY_MS, 'native inbound assertion delay', 30000);
  const maxBytes = 16 * 1024 * 1024;
  let canonicalRemoteActorUri = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      canonicalRemoteActorUri ??= await resolveCanonicalRemoteActorUri(origin.remoteActorUri);
      if (fs.existsSync(evidencePath)) {
        if (fs.statSync(evidencePath).size > maxBytes) {
          throw new Error('native inbound evidence exceeds 16 MiB');
        }
        const content = fs.readFileSync(evidencePath, 'utf8');
        const rows = content.split(/\n/u).filter(Boolean).map((line, index) => {
          try { return JSON.parse(line); }
          catch { throw new Error(`native inbound evidence line ${index + 1} is not valid JSON`); }
        });
        const matches = rows.filter(row => isMatchingNativeInboundAccept(row, origin, canonicalRemoteActorUri, targetHost));
        if (matches.length >= 1) {
          const semanticKeys = new Set(matches.map(row => JSON.stringify([
            row.activityId, row.actorUri, row.objectId, row.objectActorUri, row.objectTargetUri, row.bodySha256Base64,
          ])));
          if (semanticKeys.size !== 1) {
            throw new Error('conflicting native Accept receipts matched the same Follow');
          }
          const match = matches[0];
          if (typeof match.activityId !== 'string' || match.activityId.length === 0) {
            throw new Error('matching native Accept has no activity id');
          }
          if (!Number.isInteger(match.bodyBytes) || match.bodyBytes < 1 || typeof match.bodySha256Base64 !== 'string') {
            throw new Error('matching native Accept has incomplete bounded body evidence');
          }
          return {
            match,
            receiptCount: matches.length,
            canonicalRemoteActorUri,
          };
        }
      }
      lastError = new Error(`no successful native ActivityPods receipt correlated the exact Follow ${origin.activityId}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
  }
  throw lastError ?? new Error('native inbound accept proof timed out');
}

async function run(argv = process.argv.slice(2)) {
  const [evidencePath, originPath, targetHost, outputPath] = argv;
  if (!evidencePath || !originPath || !targetHost || !outputPath) {
    console.error('usage: assert-real-native-inbound-accept.mjs <inbound.jsonl> <origin.json> <target-host> <output.json>');
    process.exit(2);
  }

  if (!fs.existsSync(originPath)) fail(`origin file not found: ${originPath}`);
  const origin = JSON.parse(fs.readFileSync(originPath, 'utf8'));
  if (origin?.ok !== true || origin.mode !== 'native') fail('origin is not a successful native proof');
  for (const key of ['activityId', 'actorUri', 'remoteActorUri']) {
    if (typeof origin[key] !== 'string' || origin[key].length === 0) fail(`origin is missing ${key}`);
  }

  const { match, receiptCount } = await waitForNativeInboundAccept(evidencePath, origin, targetHost);

  const result = {
    schema: 'activitypods.activitypub.real-native-inbound-accept.v1',
    ok: true,
    actorUri: origin.actorUri,
    followActivityId: origin.activityId,
    remoteActorUri: origin.remoteActorUri,
    acceptActivityId: match.activityId,
    acceptedByActivityPods: true,
    receiptCount,
    bodySha256Base64: match.bodySha256Base64,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isMatchingNativeInboundAccept(row, origin, canonicalRemoteActorUri, targetHost) {
  if (row?.schema !== 'ap.real-inbound-api-call.v1' || row.method !== 'POST') return false;
  if (!Number.isInteger(row.responseStatus) || row.responseStatus < 200 || row.responseStatus > 299) return false;
  if (!['Accept', 'https://www.w3.org/ns/activitystreams#Accept'].includes(row.activityType)) return false;
  if (!['Follow', 'https://www.w3.org/ns/activitystreams#Follow'].includes(row.objectType)) return false;
  if (row.objectId !== origin.activityId || row.objectActorUri !== origin.actorUri) return false;
  if (row.actorUri !== canonicalRemoteActorUri || row.objectTargetUri !== canonicalRemoteActorUri) return false;
  try { return new URL(canonicalRemoteActorUri).hostname === targetHost; } catch { return false; }
}

function selfTest() {
  const origin = {
    activityId: 'https://activitypods.test/alice/follows/1',
    actorUri: 'https://activitypods.test/alice',
    remoteActorUri: 'https://remote.test/users/bob',
  };
  const canonicalRemoteActorUri = 'https://remote.test/ap/users/123';
  const receipt = {
    schema: 'ap.real-inbound-api-call.v1',
    method: 'POST',
    path: '/alice/inbox',
    responseStatus: 202,
    bodyBytes: 321,
    bodySha256Base64: 'proof-sha',
    activityId: 'https://remote.test/accept/1',
    activityType: 'Accept',
    actorUri: canonicalRemoteActorUri,
    objectId: origin.activityId,
    objectType: 'Follow',
    objectActorUri: origin.actorUri,
    objectTargetUri: canonicalRemoteActorUri,
  };
  if (!isMatchingNativeInboundAccept(receipt, origin, canonicalRemoteActorUri, 'remote.test')) {
    throw new Error('self-test matching native inbound Accept failed');
  }
  if (isMatchingNativeInboundAccept({ ...receipt, responseStatus: 401 }, origin, canonicalRemoteActorUri, 'remote.test')) {
    throw new Error('self-test 401 response status failed closed');
  }
  if (isMatchingNativeInboundAccept({ ...receipt, actorUri: 'https://evil.test/users/bob' }, origin, canonicalRemoteActorUri, 'remote.test')) {
    throw new Error('self-test mismatched actor failed closed');
  }
  if (isMatchingNativeInboundAccept({ ...receipt, objectId: 'https://activitypods.test/alice/follows/2' }, origin, canonicalRemoteActorUri, 'remote.test')) {
    throw new Error('self-test mismatched objectId failed closed');
  }
  process.stdout.write('ok\n');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === '--self-test') {
    selfTest();
  } else {
    run().catch(error => fail(error instanceof Error ? error.message : String(error)));
  }
}

export { isMatchingNativeInboundAccept, waitForNativeInboundAccept, selfTest };
