#!/usr/bin/env node
import Redis from 'ioredis';
import { appendFile } from 'node:fs/promises';

const redisUrl = process.env.SEMAPPS_QUEUE_SERVICE_URL || 'redis://127.0.0.1:6379/1';
const evidencePath = process.env.AP_REAL_BULL_EVIDENCE_PATH || null;
const pollMs = Number(process.env.AP_REAL_BULL_POLL_MS || 500);
const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
let stopped = false;
const seen = new Map();

function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function classify(id) {
  const base = 'bull:remotePost';
  const [failed, completed, delayed, activeIndex, waitIndex] = await Promise.all([
    redis.zscore(`${base}:failed`, id),
    redis.zscore(`${base}:completed`, id),
    redis.zscore(`${base}:delayed`, id),
    redis.lpos(`${base}:active`, id),
    redis.lpos(`${base}:wait`, id)
  ]);
  if (failed !== null) return 'failed';
  if (completed !== null) return 'completed';
  if (delayed !== null) return 'delayed';
  if (activeIndex !== null) return 'active';
  if (waitIndex !== null) return 'waiting';
  return 'unknown';
}

async function snapshotKey(key) {
  if ((await redis.type(key)) !== 'hash') return null;
  const id = key.slice('bull:remotePost:'.length);
  if (!id || id.includes(':')) return null;
  const fields = await redis.hgetall(key);
  if (!fields.name) return null;
  const data = safeJson(fields.data, {});
  const opts = safeJson(fields.opts, {});
  const stacktrace = safeJson(fields.stacktrace, []);
  return {
    schema: 'activitypods.semapps.remote-post-bull.v1',
    observedAt: Date.now(),
    id,
    state: await classify(id),
    name: fields.name,
    recipientUri: data?.recipientUri || null,
    activityId: data?.activity?.id || null,
    actorUri: data?.activity?.actor || null,
    attemptsMade: Number(fields.attemptsMade || 0),
    configuredAttempts: Number(opts?.attempts || 1),
    delay: Number(fields.delay || 0),
    timestamp: Number(fields.timestamp || 0),
    processedOn: fields.processedOn ? Number(fields.processedOn) : null,
    finishedOn: fields.finishedOn ? Number(fields.finishedOn) : null,
    failedReason: fields.failedReason || null,
    stacktrace: Array.isArray(stacktrace) ? stacktrace.slice(-3) : []
  };
}

async function emit(record) {
  const stable = JSON.stringify({ ...record, observedAt: undefined });
  if (seen.get(record.id) === stable) return;
  seen.set(record.id, stable);
  const line = JSON.stringify(record);
  process.stdout.write(`[AP-REAL-BULL] ${line}\n`);
  if (evidencePath) await appendFile(evidencePath, `${line}\n`, 'utf8');
}

async function poll() {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'bull:remotePost:*', 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const record = await snapshotKey(key);
      if (record) await emit(record);
    }
  } while (cursor !== '0');
}

async function main() {
  await redis.connect();
  while (!stopped) {
    try { await poll(); } catch (error) {
      process.stdout.write(`[AP-REAL-BULL] ${JSON.stringify({ schema: 'activitypods.semapps.remote-post-bull-error.v1', observedAt: Date.now(), error: error.message })}\n`);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { stopped = true; });
}

try {
  await main();
} finally {
  await redis.quit().catch(() => redis.disconnect());
}
