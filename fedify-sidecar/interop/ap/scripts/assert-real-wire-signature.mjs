#!/usr/bin/env node
import fs from 'node:fs';

const [wirePath, descriptorPath, targetHost, outputPath, signingPath] = process.argv.slice(2);
if (!wirePath || !descriptorPath || !targetHost) {
  console.error('usage: assert-real-wire-signature.mjs <wire.jsonl> <descriptor.json> <target-host> [output.json] [signing.json]');
  process.exit(2);
}

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const EXPECTED_SIGNED_HEADERS = '(request-target) host date digest';

const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
const actorUri = requiredString(descriptor.actorUri, 'descriptor.actorUri');
const activityId = requiredString(descriptor.activityId, 'descriptor.activityId');
const remoteActorUri = requiredString(descriptor.remoteActorUri, 'descriptor.remoteActorUri');
const mode = requiredString(descriptor.mode, 'descriptor.mode');
if (!['native', 'external', 'sidecar_service'].includes(mode)) {
  fail(`unsupported descriptor mode: ${mode}`);
}
if (mode === 'native') {
  if (descriptor.ok !== true || descriptor.durableHandoffQueued !== false) {
    fail('native descriptor does not prove native control-lane invariants');
  }
}
if (mode === 'external') {
  if (
    descriptor.ok !== true ||
    descriptor.durableHandoffQueued !== true ||
    descriptor.nativeRemotePostSuppressed !== true
  ) {
    fail('external descriptor does not prove sidecar handoff/native-suppression invariants');
  }
}
if (mode === 'sidecar_service' && descriptor.ok !== true) {
  fail('sidecar service descriptor is not successful');
}

if (!fs.existsSync(wirePath) || fs.statSync(wirePath).size > MAX_EVIDENCE_BYTES) {
  fail('wire evidence is missing or exceeds the 16 MiB bound');
}
const rows = fs.readFileSync(wirePath, 'utf8')
  .split(/\n/u)
  .filter(Boolean)
  .map((line, index) => {
    try { return JSON.parse(line); }
    catch { fail(`wire evidence line ${index + 1} is not valid JSON`); }
  });

const matches = rows.filter(row =>
  row?.schema === 'ap.interop.wire-request.v1' &&
  row.method === 'POST' &&
  row.host === targetHost &&
  row.activityId === activityId &&
  row.activityType === 'Follow' &&
  row.actorUri === actorUri &&
  row.objectUri === remoteActorUri
);
if (matches.length !== 1) {
  fail(`expected exactly one wire Follow for ${activityId}; found ${matches.length}`);
}
const match = matches[0];
const bodySha256Base64 = requiredString(match.bodySha256Base64, 'wire.bodySha256Base64');
if (match.digest !== `SHA-256=${bodySha256Base64}`) {
  fail('wire Digest does not match the exact transmitted body hash');
}
if (!Number.isInteger(match.bodyBytes) || match.bodyBytes <= 0) {
  fail('wire evidence has no positive body byte count');
}
const wireSignatureValue = requiredString(match.signature, 'wire.signature');
const signature = parseSignature(wireSignatureValue);
if (signature.headers !== EXPECTED_SIGNED_HEADERS) {
  fail(`wire Signature headers must equal ${EXPECTED_SIGNED_HEADERS}`);
}
if (signature.algorithm !== 'rsa-sha256') {
  fail(`wire Signature algorithm must explicitly equal rsa-sha256; got ${signature.algorithm || 'missing'}`);
}
if (!signature.signature) fail('wire Signature is missing cryptographic signature bytes');
const wireDate = requiredString(match.date, 'wire.date');
if (!Number.isFinite(Date.parse(wireDate))) {
  fail('wire Date header is missing or invalid');
}

const actorUrl = credentialFreeActorUrl(actorUri);
if (!actorUrl) {
  fail('descriptor.actorUri must be a credential-free HTTP(S) URL without query or fragment');
}
actorUrl.hash = 'main-key';
const expectedKeyId = actorUrl.toString();
if (signature.keyId !== expectedKeyId) {
  fail(`wire keyId authority mismatch: expected ${expectedKeyId}, got ${signature.keyId}`);
}

let signingCorrelation = null;
if (signingPath) {
  const signing = JSON.parse(fs.readFileSync(signingPath, 'utf8'));
  if (
    signing.ok !== true ||
    signing.activityId !== activityId ||
    signing.actorUri !== actorUri ||
    signing.targetHost !== targetHost ||
    !Array.isArray(signing.signerKeyIds) ||
    signing.signerKeyIds.length !== 1 ||
    signing.signerKeyIds[0] !== expectedKeyId ||
    !Array.isArray(signing.bodySha256Base64) ||
    signing.bodySha256Base64.length !== 1 ||
    signing.bodySha256Base64[0] !== bodySha256Base64 ||
    signing.signature !== wireSignatureValue ||
    signing.date !== wireDate ||
    signing.digest !== match.digest
  ) {
    fail('ActivityPods signing-API evidence does not match the observed wire request exactly');
  }
  signingCorrelation = {
    successfulSigningCalls: signing.successfulSigningCalls,
    requestIds: signing.requestIds,
    exactSignedHeadersMatched: true,
  };
}

const evidence = {
  schema: 'activitypods.activitypub.real-wire-signature.v1',
  ok: true,
  mode,
  actorUri,
  activityId,
  remoteActorUri,
  targetHost,
  path: match.path,
  bodyBytes: match.bodyBytes,
  bodySha256Base64,
  keyId: signature.keyId,
  signedHeaders: signature.headers,
  algorithm: signature.algorithm,
  ...(signingCorrelation ? { signingCorrelation } : {}),
};
const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) fs.writeFileSync(outputPath, json);
process.stdout.write(json);

function parseSignature(value) {
  const result = {};
  for (const part of value.split(/,(?=\s*[A-Za-z][A-Za-z0-9_-]*=)/u)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))\s*$/u.exec(part);
    if (!match) continue;
    result[match[1]] = match[2] ?? match[3] ?? '';
  }
  return result;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function credentialFreeActorUrl(value) {
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
