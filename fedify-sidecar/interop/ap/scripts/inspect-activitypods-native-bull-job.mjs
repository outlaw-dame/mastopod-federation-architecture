#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty, whitespace-free string`);
  }
  return value;
}

function positiveInteger(value, fallback, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

const queueUrl = requireNonEmpty(process.env.SEMAPPS_QUEUE_SERVICE_URL, 'SEMAPPS_QUEUE_SERVICE_URL');
const recipientUri = requireNonEmpty(process.env.AP_FEDERATION_REMOTE_ACTOR_URI, 'AP_FEDERATION_REMOTE_ACTOR_URI');
const activityId = requireNonEmpty(process.env.AP_FEDERATION_ACTIVITY_ID, 'AP_FEDERATION_ACTIVITY_ID');
const outputPath = process.env.AP_FEDERATION_BULL_EVIDENCE_PATH
  ? path.resolve(process.env.AP_FEDERATION_BULL_EVIDENCE_PATH)
  : null;
const timeoutMs = positiveInteger(process.env.AP_FEDERATION_BULL_TIMEOUT_MS, 15_000, 'AP_FEDERATION_BULL_TIMEOUT_MS');
const pollMs = positiveInteger(process.env.AP_FEDERATION_BULL_POLL_MS, 250, 'AP_FEDERATION_BULL_POLL_MS');

const backendRequire = createRequire(path.resolve(process.cwd(), 'package.json'));
const Bull = backendRequire('bull');
const queue = new Bull('remotePost', queueUrl);

function activityIdentity(job) {
  const activity = job?.data?.activity;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return null;
  return activity.id || activity['@id'] || null;
}

async function describe(job) {
  const state = await job.getState();
  return {
    schema: 'activitypods.activitypub.native-bull-delivery.v1',
    found: true,
    queue: 'remotePost',
    state,
    jobId: String(job.id),
    jobName: job.name,
    recipientUri: job.data?.recipientUri ?? null,
    activityId: activityIdentity(job),
    attemptsMade: job.attemptsMade,
    attemptsConfigured: job.opts?.attempts ?? 1,
    failedReason: job.failedReason || null,
    stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace : [],
    delay: job.delay ?? 0,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    timestamp: job.timestamp ?? null
  };
}

async function findMatchingJob() {
  const states = ['waiting', 'active', 'delayed', 'failed', 'completed', 'paused'];
  const jobs = await queue.getJobs(states, 0, 250, true);
  return jobs.find(job =>
    job.name === recipientUri &&
    job.data?.recipientUri === recipientUri &&
    activityIdentity(job) === activityId
  ) || null;
}

const deadline = Date.now() + timeoutMs;
let evidence = null;
try {
  while (Date.now() < deadline) {
    const job = await findMatchingJob();
    if (job) {
      evidence = await describe(job);
      // A terminal state is authoritative immediately. For non-terminal states,
      // keep polling briefly so retries/failures are visible instead of racing
      // the worker at job creation time.
      if (['completed', 'failed'].includes(evidence.state)) break;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  if (!evidence) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
    evidence = {
      schema: 'activitypods.activitypub.native-bull-delivery.v1',
      found: false,
      queue: 'remotePost',
      recipientUri,
      activityId,
      counts
    };
  }

  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encoded);
  }
  process.stdout.write(encoded);
} finally {
  await queue.close();
}
