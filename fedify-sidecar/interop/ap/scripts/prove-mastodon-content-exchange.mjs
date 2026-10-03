#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const AS = 'https://www.w3.org/ns/activitystreams#';
let proofStage = 'bootstrap';

export function validateContentOrigin(origin) {
  if (origin?.ok !== true || !['native', 'external'].includes(origin.mode)) throw new Error('invalid content origin');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(origin.senderUsername)) throw new Error('invalid sender dataset');
  for (const key of ['actorUri', 'senderOutbox', 'remoteActorUri']) {
    const url = new URL(origin[key]);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        /[<>\\\s]/.test(origin[key]) || url.href !== origin[key]) throw new Error(`invalid origin ${key}`);
  }
  if (new URL(origin.senderOutbox).origin !== new URL(origin.actorUri).origin) throw new Error('outbox authority mismatch');
  if (origin.remoteActorUri !== 'https://mastodon/users/interop') throw new Error('content adapter only supports isolated Mastodon fixture');
  return origin;
}

export function assertInboundContent(rows, remoteActorUri, objectUri, marker) {
  if (!Array.isArray(rows) || rows.length !== 1 ||
      rows[0]?.actor?.value !== remoteActorUri || rows[0]?.object?.value !== objectUri ||
      !rows[0]?.content?.value?.includes(marker) || typeof rows[0]?.activity?.value !== 'string') {
    throw new Error('remote Create is not persisted with exact actor, object, content, and inbox membership');
  }
  return rows[0].activity.value;
}

export function inboundContentQuery(inbox, remoteActorUri, objectUri) {
  for (const uri of [inbox, remoteActorUri, objectUri]) {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || /[<>\\\s]/.test(uri)) {
      throw new Error('invalid persistence query identity');
    }
  }
  // Pinned SemApps objectIdToCurrent stores inline objects as a snapshot with
  // as:current, not as an as:object edge directly to the live object URI.
  return `PREFIX as: <${AS}> SELECT DISTINCT ?activity ?actor ?object ?content WHERE {
    <${inbox}> as:items ?activity .
    ?activity a as:Create; as:actor ?actor; as:object ?storedObject .
    { ?storedObject as:current ?object } UNION { BIND(?storedObject AS ?object) }
    FILTER(?actor = <${remoteActorUri}> && ?object = <${objectUri}>)
    ?storedObject as:attributedTo <${remoteActorUri}>; as:content ?content .
  } LIMIT 2`;
}

export async function poll(check, options = {}) {
  const attempts = options.attempts ?? 60;
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let i = 0; i < attempts; i++) {
    // Query/transport errors are failures, not absence or a successful assertion.
    const result = await check();
    if (result) return result;
    if (i + 1 < attempts) await delay(Math.min(5000, 500 * 2 ** Math.min(i, 4)));
  }
  throw new Error('content persistence did not converge within the bounded polling budget');
}

async function main() {
  const [originFile, outputFile] = process.argv.slice(2);
  if (!originFile || !outputFile) throw new Error('usage: prove-mastodon-content-exchange.mjs <origin.json> <output.json>');
  const origin = validateContentOrigin(JSON.parse(fs.readFileSync(originFile, 'utf8')));
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) throw new Error('GITHUB_WORKSPACE is required for isolated fixture proof');
  const backend = path.join(workspace, 'activitypods/pod-provider/backend');
  const require = createRequire(path.join(backend, 'package.json'));
  const { createRunnerBroker, normalizeEntityId, extractExternalDeliveryTarget } = require('./scripts/activitypub-federation-follow-proof.js');
  const broker = createRunnerBroker(process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://127.0.0.1:6379/12', `content-${randomUUID()}`);
  const handoffs = [];
  broker.createService({ name: `content-evidence-${randomUUID()}`, events: {
    'activitypub.outbox.remote-delivery.handoff-queued': { handler(ctx) {
      if (ctx.params?.activity?.type === 'Create' && normalizeEntityId(ctx.params.activity.actor) === origin.actorUri) {
        handoffs.push(ctx.params);
      }
    } },
  } });
  const evidenceRoot = path.dirname(outputFile);
  const signingLog = path.join(evidenceRoot, 'signing-api.jsonl');
  const compose = ['compose', '-f', path.join(workspace, 'fedify-sidecar/interop/ap/docker-compose.ap-interop.yml')];
  async function docker(args, extraEnv = {}) {
    const result = await execFile('docker', [...compose, ...args], {
      env: { ...process.env, ...extraEnv }, timeout: 120000, maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  }
  const meta = { webId: origin.actorUri, dataset: origin.senderUsername };
  await broker.start();
  try {
    await broker.waitForServices(['activitypub.outbox', 'triplestore', 'ldp.resource'], 120000);
    const actor = await broker.call('ldp.resource.get', { resourceUri: origin.actorUri }, { meta });
    const inbox = normalizeEntityId(actor.inbox);
    if (!inbox || new URL(inbox).origin !== new URL(origin.actorUri).origin || /[<>\\\s]/.test(inbox)) {
      throw new Error('recipient inbox authority mismatch');
    }
    const outboundMarker = `ap-content-out-${randomUUID()}`;
    const sqlLiteral = value => `'${value.replaceAll("'", "''")}'`;
    const baseline = await docker(['exec', '-T', 'mastodon-db', 'psql', '-U', 'postgres', '-d', 'mastodon_production', '-v', 'ON_ERROR_STOP=1', '-tAc',
      `select count(*) from statuses where text like ${sqlLiteral(`%${outboundMarker}%`)};`]);
    if (baseline !== '0') throw new Error('outbound marker already exists before publication');
    const signingOffset = origin.mode === 'external' ? fs.statSync(signingLog).size : 0;
    proofStage = 'local-create-publication';
    const activity = await broker.call('activitypub.outbox.post', {
      collectionUri: origin.senderOutbox, type: 'Create', actor: origin.actorUri,
      object: { type: 'Note', attributedTo: origin.actorUri, content: outboundMarker,
        to: [origin.remoteActorUri] }, to: [origin.remoteActorUri],
    }, { meta });
    const objectUri = normalizeEntityId(activity.object);
    if (!objectUri || normalizeEntityId(activity.actor) !== origin.actorUri || activity.type !== 'Create') {
      throw new Error('outbox did not persist the exact Create');
    }
    proofStage = 'remote-create-persistence';
    const query = `select count(*) from statuses s join accounts a on a.id=s.account_id where s.uri=${sqlLiteral(objectUri)} and a.uri=${sqlLiteral(origin.actorUri)} and s.text like ${sqlLiteral(`%${outboundMarker}%`)};`;
    await poll(async () => {
      const count = await docker(['exec', '-T', 'mastodon-db', 'psql', '-U', 'postgres', '-d', 'mastodon_production', '-v', 'ON_ERROR_STOP=1', '-tAc', query]);
      if (!/^\d+$/.test(count)) throw new Error('remote status query returned invalid evidence');
      if (Number(count) > 1) throw new Error('duplicate remote status processing');
      return count === '1';
    });

    let remoteDeliveryTarget;
    proofStage = 'create-signing-authority';
    if (origin.mode === 'external') {
      const handoff = await poll(() => {
        const matches = handoffs.filter(item => normalizeEntityId(item.activity) === activity.id);
        if (matches.length > 1) throw new Error('duplicate Create handoff evidence');
        return matches[0] || false;
      });
      if (handoff.deliveryMode !== 'external' || handoff.durableHandoffQueued !== true || handoff.suppressedNativeRemotePostCount !== 1) {
        throw new Error('Create did not prove durable handoff and exact native suppression');
      }
      remoteDeliveryTarget = extractExternalDeliveryTarget({ handoff, postResult: activity,
        senderWebId: origin.actorUri, remoteActorUri: origin.remoteActorUri });
    }
    const descriptorPath = path.join(evidenceRoot, `${origin.mode}-content-origin.json`);
    const descriptor = { ok: true, mode: origin.mode, actorUri: origin.actorUri,
      remoteActorUri: origin.remoteActorUri, activityId: activity.id, activityType: 'Create', objectUri,
      durableHandoffQueued: origin.mode === 'external', nativeRemotePostSuppressed: origin.mode === 'external',
      ...(remoteDeliveryTarget ? { remoteDeliveryTarget } : {}) };
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
    const signingPath = path.join(evidenceRoot, `${origin.mode}-content-signing.json`);
    if (origin.mode === 'external') {
      // Preserve every call in this publication window, including unexpected POSTs.
      // Never filter by actor or type before the fail-closed authority assertion.
      const size = fs.statSync(signingLog).size;
      if (size < signingOffset || size - signingOffset > 10 * 1024 * 1024) throw new Error('invalid signing evidence window');
      const windowPath = path.join(evidenceRoot, 'external-content-signing-api.jsonl');
      const fd = fs.openSync(signingLog, 'r');
      try {
        const bytes = Buffer.alloc(size - signingOffset);
        if (fs.readSync(fd, bytes, 0, bytes.length, signingOffset) !== bytes.length) throw new Error('incomplete signing evidence window');
        fs.writeFileSync(windowPath, bytes);
      } finally { fs.closeSync(fd); }
      await execFile(process.execPath, [fileURLToPath(new URL('./assert-real-signing-call.mjs', import.meta.url)),
        windowPath, descriptorPath, 'mastodon', signingPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
    }
    if (!process.env.WIRE_EVIDENCE_PATH) throw new Error('WIRE_EVIDENCE_PATH is required');
    const wirePath = path.join(evidenceRoot, `${origin.mode}-content-wire.json`);
    await execFile(process.execPath, [fileURLToPath(new URL('./assert-real-wire-signature.mjs', import.meta.url)),
      path.resolve(workspace, process.env.WIRE_EVIDENCE_PATH), descriptorPath, 'mastodon', wirePath,
      ...(origin.mode === 'external' ? [signingPath] : [])], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const wire = JSON.parse(fs.readFileSync(wirePath, 'utf8'));
    if (wire.independentlyVerifiedRsa !== true ||
        (origin.mode === 'external' && wire.signingCorrelation?.exactSignedHeadersMatched !== true)) {
      throw new Error('Create signature authority not independently verified');
    }

    const inboundMarker = `ap-content-in-${randomUUID()}`;
    proofStage = 'remote-create-publication';
    const inboundBaseline = await broker.call('triplestore.query', {
      query: `PREFIX as: <${AS}> SELECT ?object WHERE { ?object as:content ?content . FILTER(CONTAINS(STR(?content), ${JSON.stringify(inboundMarker)})) } LIMIT 1`,
      accept: 'application/json', dataset: origin.senderUsername, webId: 'system',
    });
    if (!Array.isArray(inboundBaseline) || inboundBaseline.length !== 0) throw new Error('inbound marker already exists before publication');
    // Production PostStatusService creates the local status and schedules normal
    // ActivityPub distribution to followers. No inbox injection or direct DB insert.
    const ruby = 'account = Account.find_by!(username: "interop", domain: nil); status = PostStatusService.new.call(account, text: ENV.fetch("AP_PROOF_MARKER"), visibility: :public); puts JSON.generate({objectUri: ActivityPub::TagManager.instance.uri_for(status), actorUri: ActivityPub::TagManager.instance.uri_for(account)})';
    const remoteOutput = await docker(['exec', '-T', '-e', 'AP_PROOF_MARKER', 'mastodon-web-app', 'bundle', 'exec', 'rails', 'runner', ruby], { AP_PROOF_MARKER: inboundMarker });
    const remote = JSON.parse(remoteOutput.split('\n').at(-1));
    if (remote.actorUri !== origin.remoteActorUri || typeof remote.objectUri !== 'string' ||
        new URL(remote.objectUri).origin !== new URL(origin.remoteActorUri).origin || /[<>\\\s]/.test(remote.objectUri)) {
      throw new Error('remote production status has incorrect identity');
    }
    const inboundQuery = inboundContentQuery(inbox, origin.remoteActorUri, remote.objectUri);
    proofStage = 'local-inbox-create-persistence';
    const inboundActivityId = await poll(async () => {
      const rows = await broker.call('triplestore.query', { query: inboundQuery,
        accept: 'application/json', dataset: origin.senderUsername, webId: 'system' });
      if (!Array.isArray(rows)) throw new Error('inbound persistence query returned invalid evidence');
      if (rows.length === 0) return false;
      return assertInboundContent(rows, origin.remoteActorUri, remote.objectUri, inboundMarker);
    });
    fs.writeFileSync(outputFile, JSON.stringify({ schema: 'activitypods.activitypub.content-exchange.v1',
      ok: true, mode: origin.mode, actorUri: origin.actorUri, remoteActorUri: origin.remoteActorUri,
      outbound: { activityId: activity.id, objectUri, marker: outboundMarker, remotePersisted: true,
        independentlyVerifiedRsa: true, ...(origin.mode === 'external' ? { planBoundSigning: true } : {}) },
      inbound: { activityId: inboundActivityId, objectUri: remote.objectUri, marker: inboundMarker, inboxPersisted: true },
    }, null, 2) + '\n');
  } finally { await broker.stop(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Do not print broker payloads, subprocess stdout/stderr, or signed bodies.
    const code = /^[A-Z0-9_]{1,40}$/.test(String(error?.code)) ? error.code : 'ASSERTION_OR_RUNTIME_ERROR';
    console.error(`real Mastodon content exchange failed at ${proofStage} (${code}); no complete content proof emitted`);
    process.exitCode = 1;
  });
}
