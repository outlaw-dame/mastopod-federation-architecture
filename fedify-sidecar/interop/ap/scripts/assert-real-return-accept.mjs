#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';

const AS_ACCEPT = 'Accept';
const INBOUND_STREAM = process.env.INBOUND_STREAM_KEY || 'ap:queue:inbound:v1';
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
  if (normalizeEntityId(activity.actor) !== origin.remoteActorUri) return false;
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
    if (objectTarget !== null && objectTarget !== origin.remoteActorUri) return false;
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
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/activity+json, application/ld+json, application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).origin}`);
  return await response.json();
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
    if (members.includes(origin.remoteActorUri)) return true;

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

function arrayOf(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function readMatchingSidecarAccept(origin) {
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
      return { observed: true, streamId: entry.id, path };
    }
    return { observed: false, streamId: null, path: null };
  } finally {
    await client.quit();
  }
}

async function waitForBidirectionalProof(mode, origin) {
  const attempts = parsePositiveInteger(process.env.AP_INTEROP_RETURN_ASSERT_ATTEMPTS, DEFAULT_ATTEMPTS, 'return assertion attempts', 300);
  const delayMs = parsePositiveInteger(process.env.AP_INTEROP_RETURN_ASSERT_DELAY_MS, DEFAULT_DELAY_MS, 'return assertion delay', 30000);
  let followingUri = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      followingUri ??= await resolveFollowingUri(origin.actorUri);
      const followingContainsRemote = await queryFollowingMembership(origin, followingUri);
      const sidecar = mode === 'external' ? await readMatchingSidecarAccept(origin) : { observed: false, streamId: null, path: null };
      if (followingContainsRemote && (mode === 'native' || sidecar.observed)) {
        return {
          followingUri,
          followingContainsRemote,
          returnAcceptApplied: true,
          sidecarInboundAcceptObserved: sidecar.observed,
          sidecarInboundStreamId: sidecar.streamId,
          sidecarInboundPath: sidecar.path,
        };
      }
      lastError = new Error(
        mode === 'external' && !sidecar.observed
          ? 'matching returning Accept has not traversed the sidecar inbound stream yet'
          : 'ActivityPods following collection has not applied the remote Accept yet',
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw lastError ?? new Error('bidirectional federation proof timed out');
}

async function run(argv = process.argv.slice(2)) {
  if (argv.length !== 6) {
    throw new Error('Usage: assert-real-return-accept.mjs <native|external> <origin-json> <target> <actor-uri> <remote-username> <persisted-follow-count>');
  }
  const [mode, originPath, target, actorUri, remoteUsernameRaw, persistedCountRaw] = argv;
  if (!['native', 'external'].includes(mode)) throw new Error(`unsupported proof mode ${mode}`);
  const remoteUsername = validateRemoteUsername(remoteUsernameRaw);
  const persistedFollowCount = Number(persistedCountRaw);
  if (!Number.isSafeInteger(persistedFollowCount) || persistedFollowCount < 1) throw new Error('persisted follow count must be positive');
  const origin = validateOrigin(JSON.parse(await readFile(originPath, 'utf8')));
  if (origin.mode !== mode) throw new Error('origin proof mode mismatch');
  if (origin.actorUri !== actorUri) throw new Error('remote persistence actor does not match origin actor');
  const evidence = await waitForBidirectionalProof(mode, origin);
  process.stdout.write(`${JSON.stringify({
    schema: 'activitypods.activitypub.real-bidirectional-acceptance.v1',
    ok: true,
    target,
    mode,
    actorUri,
    localUsername: origin.senderUsername,
    remoteUsername,
    remoteActorUri: origin.remoteActorUri,
    activityId: origin.activityId,
    persistedFollowCount,
    returnAcceptApplied: evidence.returnAcceptApplied,
    followingContainsRemote: evidence.followingContainsRemote,
    sidecarInboundAcceptObserved: evidence.sidecarInboundAcceptObserved,
    sidecarInboundPath: evidence.sidecarInboundPath,
  })}\n`);
}

function selfTest() {
  const origin = {
    activityId: 'https://activitypods.test/alice/outbox/1',
    actorUri: 'https://activitypods.test/alice',
    remoteActorUri: 'https://remote.test/users/bob',
  };
  const matching = {
    type: 'Accept',
    actor: origin.remoteActorUri,
    object: { type: 'Follow', id: origin.activityId, actor: origin.actorUri, object: origin.remoteActorUri },
  };
  if (!isMatchingReturnAccept(matching, origin)) throw new Error('self-test matching Accept failed');
  if (isMatchingReturnAccept({ ...matching, actor: 'https://evil.test/users/bob' }, origin)) throw new Error('self-test actor mismatch failed closed');
  if (isMatchingReturnAccept({ ...matching, object: { ...matching.object, id: 'https://activitypods.test/alice/outbox/2' } }, origin)) throw new Error('self-test Follow id mismatch failed closed');
  if (validateRemoteUsername('interop') !== 'interop') throw new Error('self-test remote username validation failed');
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

export { isMatchingReturnAccept, normalizeEntityId, queryFollowingMembership, validateOrigin, validateRemoteUsername };
