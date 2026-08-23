import { readFile } from 'node:fs/promises';
import { Client } from '@opensearch-project/opensearch';
import { createClient } from 'redis';
import { Kafka, logLevel } from 'kafkajs';
import { ensureRedpandaCompressionCodec } from '../src/streams/kafka-compression.js';

const opensearchUrl = process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:19200';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:16379';
const brokers = (process.env.REDPANDA_BROKERS ?? '127.0.0.1:19092').split(',');
const marker = process.env.OS4B_FEDERATION_MARKER;
const expected = Number(process.env.OS4B_FEDERATION_COUNT ?? 240);
const timeoutMs = Number(process.env.OS4B_FEDERATION_TIMEOUT_MS ?? 120000);
const sidecarLogPath = process.env.OS4B_SIDECAR_LOG_PATH ?? '../artifacts/os4b-live/sidecar.log';
if (!marker) throw new Error('OS4B_FEDERATION_MARKER is required');
const invalidMarker = `${marker}-invalid-signature`;

const os = new Client({ node: opensearchUrl });
const redis = createClient({ url: redisUrl });
await redis.connect();
ensureRedpandaCompressionCodec();
const kafka = new Kafka({ clientId: `os4b-live-verify-${Date.now()}`, brokers, logLevel: logLevel.NOTHING });
const consumer = kafka.consumer({ groupId: `os4b-live-verify-${Date.now()}` });
await consumer.connect();
await consumer.subscribe({ topic: 'ap.stream2.remote-public.v1', fromBeginning: true });
let stream2Matched = 0;
let stream2Invalid = 0;
const observed = new Set<string>();
await consumer.run({ eachMessage: async ({ message }) => {
  const raw = message.value?.toString() ?? '';
  if (raw.includes(invalidMarker)) {
    stream2Invalid++;
    return;
  }
  if (!raw.includes(marker)) return;
  try {
    const event = JSON.parse(raw);
    const id = event?.activity?.id;
    if (typeof id === 'string' && !observed.has(id)) {
      observed.add(id);
      stream2Matched++;
    }
  } catch {}
} });

const firehoseConsumer = kafka.consumer({ groupId: `os4b-live-firehose-verify-${Date.now()}` });
await firehoseConsumer.connect();
await firehoseConsumer.subscribe({ topic: 'ap.firehose.v1', fromBeginning: true });
const firehoseIds = new Set<string>();
let firehoseMatched = 0;
let firehoseInvalid = 0;
await firehoseConsumer.run({ eachMessage: async ({ message }) => {
  const raw = message.value?.toString() ?? '';
  if (raw.includes(invalidMarker)) {
    firehoseInvalid++;
    return;
  }
  if (!raw.includes(marker)) return;
  try {
    const event = JSON.parse(raw);
    const id = event?.activity?.id;
    if (typeof id === 'string' && !firehoseIds.has(id)) {
      firehoseIds.add(id);
      firehoseMatched++;
    }
  } catch {}
} });

async function searchCount(text: string): Promise<number> {
  await os.indices.refresh({ index: 'public-content-v1' }).catch(() => undefined);
  const response: any = await os.search({
    index: 'public-content-v1',
    body: { size: 0, query: { match_phrase: { text } } },
  }).catch(() => null);
  return Number(response?.body?.hits?.total?.value ?? 0);
}

async function inboundEvidence() {
  const rows = await redis.xRange('ap:queue:inbound:v1', '-', '+').catch(() => [] as any[]);
  let valid = 0;
  let invalid = 0;
  for (const row of rows as any[]) {
    const raw = JSON.stringify(row?.message ?? {});
    if (raw.includes(invalidMarker)) invalid++;
    else if (raw.includes(marker)) valid++;
  }
  return { valid, invalid, totalEntries: rows.length };
}

async function batchingEvidence() {
  const text = await readFile(sidecarLogPath, 'utf8').catch(() => '');
  let observedBatchCalls = 0;
  let maxObservedBatchSize = 0;
  let totalBatchedDocuments = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry['msg'] !== '[SearchIndexerService] Applied OpenSearch content batch') continue;
      const size = Number(entry['contentBatchSize']);
      if (!Number.isSafeInteger(size) || size < 1) continue;
      observedBatchCalls++;
      totalBatchedDocuments += size;
      maxObservedBatchSize = Math.max(maxObservedBatchSize, size);
    } catch {}
  }
  return { observedBatchCalls, maxObservedBatchSize, totalBatchedDocuments };
}

const startedAt = Date.now();
let searchHits = 0;
let invalidSearchHits = Number.POSITIVE_INFINITY;
let inboundPending = Number.POSITIVE_INFINITY;
let inboundObserved = 0;
let inboundInvalid = Number.POSITIVE_INFINITY;
let inboundTotalEntries = 0;
let batching = { observedBatchCalls: 0, maxObservedBatchSize: 0, totalBatchedDocuments: 0 };
while (Date.now() - startedAt < timeoutMs) {
  searchHits = await searchCount(marker);
  invalidSearchHits = await searchCount(invalidMarker);
  const pendingRows = await redis.xPending('ap:queue:inbound:v1', 'sidecar-workers').catch(() => null as any);
  inboundPending = typeof pendingRows?.pending === 'number' ? pendingRows.pending : Number.POSITIVE_INFINITY;
  const inbound = await inboundEvidence();
  inboundObserved = inbound.valid;
  inboundInvalid = inbound.invalid;
  inboundTotalEntries = inbound.totalEntries;
  batching = await batchingEvidence();

  if (
    searchHits === expected
    && stream2Matched === expected
    && firehoseMatched === expected
    && inboundObserved === expected
    && inboundPending === 0
    && invalidSearchHits === 0
    && inboundInvalid === 0
    && stream2Invalid === 0
    && firehoseInvalid === 0
    && batching.observedBatchCalls > 0
    && batching.maxObservedBatchSize >= 2
  ) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

await consumer.disconnect();
await firehoseConsumer.disconnect();
await redis.quit();
await os.close();

const result = {
  ok:
    searchHits === expected
    && stream2Matched === expected
    && firehoseMatched === expected
    && inboundObserved === expected
    && inboundPending === 0
    && invalidSearchHits === 0
    && inboundInvalid === 0
    && stream2Invalid === 0
    && firehoseInvalid === 0
    && batching.observedBatchCalls > 0
    && batching.maxObservedBatchSize >= 2,
  marker,
  invalidMarker,
  expected,
  searchHits,
  stream2Matched,
  firehoseMatched,
  inboundObserved,
  inboundTotalEntries,
  inboundPending,
  batching,
  negativeControl: {
    inboundInvalid,
    stream2Invalid,
    firehoseInvalid,
    invalidSearchHits,
  },
  searchableWithinMs: Date.now() - startedAt,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
