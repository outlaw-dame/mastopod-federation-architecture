#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [logPath, originPath, expectedRemoteHost, outputPath] = process.argv.slice(2);
if (!logPath || !originPath || !expectedRemoteHost || !outputPath) {
  console.error('usage: assert-real-inbound-accept.mjs <activitypods-log> <origin-json> <remote-host> <output-json>');
  process.exit(2);
}

const attempts = Number.parseInt(process.env.AP_INBOUND_ACCEPT_ATTEMPTS ?? '60', 10);
const delayMs = Number.parseInt(process.env.AP_INBOUND_ACCEPT_DELAY_MS ?? '1000', 10);
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 300 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10000) {
  throw new Error('inbound Accept assertion bounds are invalid');
}

const origin = JSON.parse(fs.readFileSync(originPath, 'utf8'));
if (origin?.ok !== true || typeof origin.actorUri !== 'string' || typeof origin.activityId !== 'string' || typeof origin.remoteActorUri !== 'string') {
  throw new Error('origin evidence is incomplete');
}

const actor = new URL(origin.actorUri);
const remoteActor = new URL(origin.remoteActorUri);
if (actor.protocol !== 'https:' || remoteActor.protocol !== 'https:' || remoteActor.hostname !== expectedRemoteHost) {
  throw new Error('origin actor/remote authority does not match the requested live proof');
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const acceptPattern = new RegExp(
  `Processing activity (https://${escapeRegex(expectedRemoteHost)}/[^\\s]+#accepts/follows/[^\\s]+) received in the inbox of ${escapeRegex(origin.actorUri)}(?:\\.\\.\\.)?`,
  'u'
);
const failurePatterns = [
  /\[TrustEval\] evaluation error/u,
  /\[TrustEval\] evaluation unavailable/u,
  /The dataset ap doesn't exist/u,
  /TRUST_EVAL_UNAVAILABLE/u
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let match = null;
let text = '';
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  match = text.match(acceptPattern);
  if (match) break;
  if (attempt < attempts) await sleep(delayMs);
}

if (!match) {
  throw new Error(`no real ${expectedRemoteHost} Accept was processed for the exact ActivityPods actor`);
}

const acceptIndex = text.indexOf(match[0]);
const windowStart = Math.max(0, acceptIndex - 12000);
const windowEnd = Math.min(text.length, acceptIndex + match[0].length + 12000);
const acceptanceWindow = text.slice(windowStart, windowEnd);
const failure = failurePatterns.find(pattern => pattern.test(acceptanceWindow));
if (failure) {
  throw new Error('inbound Accept traversed ActivityPods with a trust-evaluation failure');
}

const result = {
  schema: 'activitypods.activitypub.real-inbound-accept.v1',
  ok: true,
  actorUri: origin.actorUri,
  followActivityId: origin.activityId,
  remoteActorUri: origin.remoteActorUri,
  acceptActivityId: match[1],
  inboundSideEffectsProcessed: true,
  trustEvaluationErrors: 0
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
