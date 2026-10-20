#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';

const AS_ACCEPT = 'Accept';
const ACTOR_TYPES = new Set(
  ['Person', 'Service', 'Application', 'Group', 'Organization']
    .flatMap(type => [type, `https://www.w3.org/ns/activitystreams#${type}`]),
);
const INBOUND_STREAM = process.env.INBOUND_STREAM_KEY || 'ap:queue:inbound:v1';
const INBOUND_DLQ_STREAM = process.env.INBOUND_DLQ_STREAM_KEY || 'ap:queue:dlq:inbound:v1';
const INBOUND_GROUP = process.env.INBOUND_CONSUMER_GROUP || 'sidecar-workers';
const DEFAULT_ATTEMPTS = 90;
const DEFAULT_DELAY_MS = 2000;

function normalizeEntityId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = value.id ?? value['@id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function normalizeType(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find(entry => typeof entry === 'string') ?? null;
  return null;
}

function isAcceptType(value) {
  const type = normalizeType(value);
  return type === AS_ACCEPT || type === 'https://www.w3.org/ns/activitystreams#Accept';
}

function isMatchingReturnAccept(activity, origin) {
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return false;
  if (!isAcceptType(activity.type ?? activity['@type'])) return false;
  const canonicalRemoteActorUri = origin.canonicalRemoteActorUri ?? origin.remoteActorUri;
  if (normalizeEntityId(activity.actor) !== canonicalRemoteActorUri) return false;
  const object = activity.object;
  const objectId = normalizeEntityId(object);
  if (objectId !== origin.activityId) return false;
  if (object && typeof object === 'object' && !Array.isArray(object)) {
    const objectType = object.type ?? object['@type'];
    if (objectType !== undefined) {
      const normalized = normalizeType(objectType);
      if (normalized !== 'Follow' && normalized !== 'https://www.w3.org/ns/activitystreams#Follow') return false;
    }
    const objectActor = normalizeEntityId(object.actor);
    if (objectActor !== null && objectActor !== origin.actorUri) return false;
    const objectTarget = normalizeEntityId(object.object);
    const identityBoundTargets = new Set([origin.remoteActorUri, canonicalRemoteActorUri]);
    if (objectTarget !== null && !identityBoundTargets.has(objectTarget)) return false;
  }
  return true;
}

function parsePositiveInteger(raw, fallback, label, max) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function validateOrigin(origin) {
  if (!origin || typeof origin !== 'object') throw new Error('origin proof must be a JSON object');
  if (origin.ok !== true || !['native', 'external'].includes(origin.mode)) throw new Error('origin proof is not successful');
  for (const key of ['activityId', 'actorUri', 'senderUsername', 'remoteActorUri']) {
    if (typeof origin[key] !== 'string' || origin[key].length === 0) throw new Error(`origin proof is missing ${key}`);
  }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(origin.senderUsername)) throw new Error('origin senderUsername is invalid');
  for (const key of ['activityId', 'actorUri', 'remoteActorUri']) {
    const parsed = new URL(origin[key]);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new Error(`origin ${key} must be a credential-free HTTPS URL without a fragment`);
    }
  }
  return origin;
}

function validateRemoteUsername(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(value)) {
    throw new Error('remote username is invalid');
  }
  return value;
}

async function fetchJson(url, options = {}) {
  const requestedUrl = new URL(url);
  let currentUrl = requestedUrl;
  let response;
  const timeoutMs = parsePositiveInteger(process.env.AP_INTEROP_FETCH_TIMEOUT_MS, 15000, 'fetch timeout', 60000);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    response = await fetch(currentUrl, {
      ...options,
      redirect: 'manual',
      headers: {
        accept: 'application/activity+json, application/ld+json, application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirectCount === 5) throw new Error('ActivityPub evidence fetch exceeded the redirect bound');
    const location = response.headers.get('location');
    if (!location) throw new Error('ActivityPub evidence redirect omitted its location');
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== 'https:' || nextUrl.origin !== requestedUrl.origin
      || nextUrl.username || nextUrl.password || nextUrl.hash) {
      throw new Error('ActivityPub evidence redirect escaped its requested HTTPS authority');
    }
    currentUrl = nextUrl;
  }
  if (!response) throw new Error('ActivityPub evidence fetch did not produce a response');
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${requestedUrl.origin}`);
  if (response.url) {
    const responseUrl = new URL(response.url);
    if (responseUrl.origin !== requestedUrl.origin || responseUrl.username || responseUrl.password) {
      throw new Error('ActivityPub evidence fetch redirected outside its requested authority');
    }
  }
  return await response.json();
}

function arrayOf(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function resolveCanonicalRemoteActorUri(requestedActorUri) {
  const requestedUrl = new URL(requestedActorUri);
  let actor;
  try {
    actor = await fetchJson(requestedUrl);
  } catch (error) {
    const statusMatch = String(error?.message).match(/HTTP\s+(401|403)/i);
    if (statusMatch) {
      const userMatch = requestedUrl.pathname.match(/^\/(?:users\/|@|profile\/)?([^/]+)/);
      if (userMatch) {
        const username = userMatch[1];
        const webfingerUrl = `https://${requestedUrl.host}/.well-known/webfinger?resource=acct:${username}@${requestedUrl.host}`;
        const jrd = await fetchJson(webfingerUrl, {
          headers: { accept: 'application/jrd+json, application/json' },
        });
        const selfLink = Array.isArray(jrd?.links)
          ? jrd.links.find(l => l?.rel === 'self' && typeof l?.href === 'string')?.href
          : null;
        if (selfLink) {
          const canonicalUrl = new URL(selfLink);
          if (canonicalUrl.protocol === 'https:' && canonicalUrl.origin === requestedUrl.origin
            && !canonicalUrl.username && !canonicalUrl.password && !canonicalUrl.hash) {
            return canonicalUrl.toString();
          }
        }
      }
    }
    throw error;
  }
  const actorTypes = arrayOf(actor?.type ?? actor?.['@type']).map(normalizeType).filter(Boolean);
  if (!actorTypes.some(type => ACTOR_TYPES.has(type))) {
    throw new Error('remote actor document does not declare a supported ActivityStreams actor type');
  }
  const canonicalActorUri = normalizeEntityId(actor);
  if (!canonicalActorUri) throw new Error('remote actor document does not expose an id');
  const canonicalUrl = new URL(canonicalActorUri);
  if (canonicalUrl.protocol !== 'https:' || canonicalUrl.origin !== requestedUrl.origin
    || canonicalUrl.username || canonicalUrl.password || canonicalUrl.hash) {
    throw new Error('remote actor canonical id escaped its requested HTTPS authority');
  }
  return canonicalUrl.toString();
}

async function resolveFollowingUri(actorUri) {
  const actor = await fetchJson(actorUri);
  const following = normalizeEntityId(actor.following);
  if (!following) throw new Error('ActivityPods actor document does not expose a following collection');
  const actorUrl = new URL(actorUri);
  const followingUrl = new URL(following);
  if (followingUrl.origin !== actorUrl.origin) throw new Error('ActivityPods following collection escaped actor authority');
  return followingUrl.toString();
}

async function queryFollowingMembership(origin, followingUri) {
  const authority = new URL(followingUri).origin;
  let page = await fetchJson(followingUri);
  const visited = new Set([followingUri]);
  for (let depth = 0; depth < 10; depth += 1) {
    const members = [...arrayOf(page?.items), ...arrayOf(page?.orderedItems)]
      .map(normalizeEntityId)
      .filter(Boolean);
    const canonicalRemoteActorUri = origin.canonicalRemoteActorUri ?? origin.remoteActorUri;
    if (members.includes(canonicalRemoteActorUri)) return true;
    const embeddedFirst = depth === 0 && members.length === 0
      && page?.first && typeof page.first === 'object' && !Array.isArray(page.first)
      ? page.first
      : null;
    if (embeddedFirst) {
      page = embeddedFirst;
      continue;
    }
    const pageReference = depth === 0 && members.length === 0
      ? normalizeEntityId(page?.first)
      : normalizeEntityId(page?.next);
    if (!pageReference) return false;
    const pageUrl = new URL(pageReference, followingUri);
    if (pageUrl.origin !== authority || pageUrl.username || pageUrl.password || visited.has(pageUrl.toString())) {
      throw new Error('ActivityPods following pagination escaped its authority or formed a cycle');
    }
    visited.add(pageUrl.toString());
    page = await fetchJson(pageUrl.toString());
  }
  throw new Error('ActivityPods following collection exceeded the bounded page traversal');
}

function parseStreamId(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)-(\d+)$/u.exec(value);
  if (!match) return null;
  return [BigInt(match[1]), BigInt(match[2])];
}

function compareStreamIds(left, right) {
  const a = parseStreamId(left);
  const b = parseStreamId(right);
  if (!a || !b) throw new Error('Redis stream evidence contains a malformed stream id');
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

function rawPairsToObject(raw) {
  if (!Array.isArray(raw)) return null;
  const out = {};
  for (let index = 0; index + 1 < raw.length; index += 2) {
    out[String(raw[index])] = raw[index + 1];
  }
  return out;
}

async function readInboundGroupState(client) {
  let groups;
  try {
    groups = await client.sendCommand(['XINFO', 'GROUPS', INBOUND_STREAM]);
  } catch (error) {
    if (String(error?.message ?? error).includes('no such key')) return null;
    throw error;
  }
  for (const raw of Array.isArray(groups) ? groups : []) {
    const group = rawPairsToObject(raw);
    if (group?.name === INBOUND_GROUP) return group;
  }
  return null;
}

async function isEnvelopeInInboundDlq(client, envelopeId) {
  let entries;
  try {
    entries = await client.xRange(INBOUND_DLQ_STREAM, '-', '+', { COUNT: 10000 });
  } catch (error) {
    if (String(error?.message ?? error).includes('no such key')) return false;
    throw error;
  }
  for (const entry of entries ?? []) {
    const message = entry.message ?? {};
    if (message.type !== 'inbound' || typeof message.data !== 'string') continue;
    try {
      const data = JSON.parse(message.data);
      if (data?.envelopeId === envelopeId) return true;
    } catch {
      // Malformed unrelated DLQ entries are not evidence for this envelope.
    }
  }
  return false;
}

async function hasDurablyProcessedSidecarAccept(client, candidate) {
  const group = await readInboundGroupState(client);
  const lastDeliveredId = typeof group?.['last-delivered-id'] === 'string'
    ? group['last-delivered-id']
    : typeof group?.lastDeliveredId === 'string'
      ? group.lastDeliveredId
      : null;
  if (!lastDeliveredId || compareStreamIds(lastDeliveredId, candidate.streamId) < 0) return false;

  const pending = await client.sendCommand([
    'XPENDING', INBOUND_STREAM, INBOUND_GROUP, candidate.streamId, candidate.streamId, '1',
  ]);
  if (Array.isArray(pending) && pending.length > 0) return false;
  if (await isEnvelopeInInboundDlq(client, candidate.envelopeId)) return false;
  return true;
}

function hasProcessedSidecarAccept(log, origin, envelopeId, acceptActivityId) {
  if (typeof log !== 'string' || typeof envelopeId !== 'string' || envelopeId.length === 0
    || typeof acceptActivityId !== 'string' || acceptActivityId.length === 0) return false;
  for (const line of log.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.msg !== 'Inbound activity processed' || event.envelopeId !== envelopeId) continue;
    if (event.activityId !== acceptActivityId || event.actor !== origin.canonicalRemoteActorUri) continue;
    if (!isAcceptType(event.type)) continue;
    return true;
  }
  return false;
}

function findProcessedSidecarAccept(candidates, log, origin) {
  return candidates.find(candidate => hasProcessedSidecarAccept(
    log, origin, candidate.envelopeId, candidate.acceptActivityId,
  )) ?? null;
}

async function readMatchingSidecarAccept(origin, logPath) {
  let log;
  try {
    log = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { observed: false, streamId: null, envelopeId: null, acceptActivityId: null, path: null };
    throw error;
  }

  const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  client.on('error', () => {});
  await client.connect();
  try {
    const entries = await client.xRange(INBOUND_STREAM, '-', '+', { COUNT: 1000 });
    for (const entry of entries) {
      const message = entry.message ?? {};
      if (message.method !== 'POST' || typeof message.body !== 'string') continue;
      let activity;
      try { activity = JSON.parse(message.body); } catch { continue; }
      if (!isMatchingReturnAccept(activity, origin)) continue;
      const path = typeof message.path === 'string' ? message.path : '';
      const actorPath = new URL(origin.actorUri).pathname.replace(/\/$/u, '');
      const allowedPaths = new Set([`${actorPath}/inbox`, `/users/${encodeURIComponent(origin.senderUsername)}/inbox`]);
      if (!allowedPaths.has(path)) continue;
      const candidate = {
        streamId: entry.id,
        envelopeId: message.envelopeId,
        acceptActivityId: normalizeEntityId(activity),
        path,
      };
      if (typeof candidate.envelopeId !== 'string' || candidate.envelopeId.length === 0
        || typeof candidate.acceptActivityId !== 'string' || candidate.acceptActivityId.length === 0) continue;
      if (!hasProcessedSidecarAccept(log, origin, candidate.envelopeId, candidate.acceptActivityId)) continue;
      if (await hasDurablyProcessedSidecarAccept(client, candidate)) return { observed: true, ...candidate };
    }
    return { observed: false, streamId: null, envelopeId: null, acceptActivityId: null, path: null };
  } finally {
    await client.quit();
  }
}

async function waitForBidirectionalProof(mode, origin, sidecarLogPath) {
  const attempts = parsePositiveInteger(process.env.AP_INTEROP_RETURN_ASSERT_ATTEMPTS, DEFAULT_ATTEMPTS, 'return assertion attempts', 300);
  const delayMs = parsePositiveInteger(process.env.AP_INTEROP_RETURN_ASSERT_DELAY_MS, DEFAULT_DELAY_MS, 'return assertion delay', 30000);
  let followingUri = null;
  let canonicalRemoteActorUri = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      canonicalRemoteActorUri ??= await resolveCanonicalRemoteActorUri(origin.remoteActorUri);
      const identityBoundOrigin = { ...origin, canonicalRemoteActorUri };
      followingUri ??= await resolveFollowingUri(origin.actorUri);
      const followingContainsRemote = await queryFollowingMembership(identityBoundOrigin, followingUri);
      const sidecar = mode === 'external'
        ? await readMatchingSidecarAccept(identityBoundOrigin, sidecarLogPath)
        : { observed: false, streamId: null, envelopeId: null, acceptActivityId: null, path: null };
      if (followingContainsRemote && (mode === 'native' || sidecar.observed)) {
        return {
          followingUri,
          canonicalRemoteActorUri,
          followingContainsRemote,
          returnAcceptApplied: true,
          returnAcceptActivityId: sidecar.acceptActivityId,
          sidecarInboundAcceptObserved: sidecar.observed,
          sidecarInboundProcessed: sidecar.observed,
          sidecarInboundStreamId: sidecar.streamId,
          sidecarInboundPath: sidecar.path,
        };
      }
      lastError = new Error(
        mode === 'external' && !sidecar.observed
          ? 'matching returning Accept lacks a correlated post-forward processing receipt and durable sidecar ACK'
          : 'ActivityPods following collection has not applied the remote Accept yet',
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
  }
  throw lastError ?? new Error('bidirectional federation proof timed out');
}

async function run(argv = process.argv.slice(2)) {
  if (argv.length < 6 || argv.length > 7) {
    throw new Error('Usage: assert-real-return-accept.mjs <native|external> <origin-json> <target> <actor-uri> <remote-username> <persisted-follow-count> [sidecar-log]');
  }
  const [mode, originPath, target, actorUri, remoteUsernameRaw, persistedCountRaw, sidecarLogPath] = argv;
  if (!['native', 'external'].includes(mode)) throw new Error(`unsupported proof mode ${mode}`);
  if (mode === 'external' && (!sidecarLogPath || sidecarLogPath.length === 0)) {
    throw new Error('external proof requires the sidecar processing log');
  }
  const remoteUsername = validateRemoteUsername(remoteUsernameRaw);
  const persistedFollowCount = Number(persistedCountRaw);
  if (!Number.isSafeInteger(persistedFollowCount) || persistedFollowCount < 1) throw new Error('persisted follow count must be positive');
  const origin = validateOrigin(JSON.parse(await readFile(originPath, 'utf8')));
  if (origin.mode !== mode) throw new Error('origin proof mode mismatch');
  if (origin.actorUri !== actorUri) throw new Error('remote persistence actor does not match origin actor');
  const evidence = await waitForBidirectionalProof(mode, origin, sidecarLogPath);
  process.stdout.write(`${JSON.stringify({
    schema: 'activitypods.activitypub.real-bidirectional-acceptance.v1',
    ok: true,
    target,
    mode,
    actorUri,
    localUsername: origin.senderUsername,
    remoteUsername,
    requestedRemoteActorUri: origin.remoteActorUri,
    remoteActorUri: evidence.canonicalRemoteActorUri,
    activityId: origin.activityId,
    persistedFollowCount,
    returnAcceptApplied: evidence.returnAcceptApplied,
    returnAcceptActivityId: evidence.returnAcceptActivityId,
    followingContainsRemote: evidence.followingContainsRemote,
    sidecarInboundAcceptObserved: evidence.sidecarInboundAcceptObserved,
    sidecarInboundProcessed: evidence.sidecarInboundProcessed,
    sidecarInboundPath: evidence.sidecarInboundPath,
  })}\n`);
}

function selfTest() {
  const origin = {
    activityId: 'https://activitypods.test/alice/outbox/1',
    actorUri: 'https://activitypods.test/alice',
    remoteActorUri: 'https://remote.test/users/bob',
    canonicalRemoteActorUri: 'https://remote.test/ap/users/123',
  };
  const matching = {
    type: 'Accept',
    actor: origin.canonicalRemoteActorUri,
    object: { type: 'Follow', id: origin.activityId, actor: origin.actorUri, object: origin.remoteActorUri },
  };
  if (!isMatchingReturnAccept(matching, origin)) throw new Error('self-test matching Accept failed');
  if (isMatchingReturnAccept({ ...matching, actor: origin.remoteActorUri }, origin)) throw new Error('self-test non-canonical actor failed closed');
  if (isMatchingReturnAccept({ ...matching, actor: 'https://evil.test/users/bob' }, origin)) throw new Error('self-test actor mismatch failed closed');
  if (isMatchingReturnAccept({ ...matching, object: { ...matching.object, id: 'https://activitypods.test/alice/outbox/2' } }, origin)) throw new Error('self-test Follow id mismatch failed closed');
  if (validateRemoteUsername('interop') !== 'interop') throw new Error('self-test remote username validation failed');
  if (compareStreamIds('10-2', '10-2') !== 0 || compareStreamIds('10-1', '10-2') >= 0 || compareStreamIds('11-0', '10-99') <= 0) {
    throw new Error('self-test Redis stream id comparison failed');
  }
  const processedLog = JSON.stringify({
    msg: 'Inbound activity processed',
    envelopeId: 'env-1',
    activityId: 'https://remote.test/accepts/1',
    actor: origin.canonicalRemoteActorUri,
    type: 'Accept',
  });
  if (!hasProcessedSidecarAccept(processedLog, origin, 'env-1', 'https://remote.test/accepts/1')) {
    throw new Error('self-test post-forward receipt correlation failed');
  }
  if (hasProcessedSidecarAccept(processedLog, origin, 'env-2', 'https://remote.test/accepts/1')) {
    throw new Error('self-test mismatched post-forward receipt failed closed');
  }
  process.stdout.write('ok\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === '--self-test') {
    selfTest();
  } else {
    run().catch(error => {
      process.stderr.write(`[AP-BIDIRECTIONAL] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  }
}

export {
  compareStreamIds,
  findProcessedSidecarAccept,
  hasDurablyProcessedSidecarAccept,
  hasProcessedSidecarAccept,
  isMatchingReturnAccept,
  normalizeEntityId,
  queryFollowingMembership,
  resolveCanonicalRemoteActorUri,
  validateOrigin,
  validateRemoteUsername,
};