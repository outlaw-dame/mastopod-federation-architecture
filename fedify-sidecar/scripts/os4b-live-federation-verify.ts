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
if (!marker) throw new Error('OS4B_FEDERATION_MARKER is required');

const os = new Client({ node: opensearchUrl });
const redis = createClient({ url: redisUrl });
await redis.connect();
ensureRedpandaCompressionCodec();
const kafka = new Kafka({ clientId: `os4b-live-verify-${Date.now()}`, brokers, logLevel: logLevel.NOTHING });
const consumer = kafka.consumer({ groupId: `os4b-live-verify-${Date.now()}` });
await consumer.connect();
await consumer.subscribe({ topic: 'ap.stream2.remote-public.v1', fromBeginning: true });
let stream2Matched = 0;
let firehoseMatched = 0;
const observed = new Set<string>();
await consumer.run({ eachMessage: async ({ message }) => {
  const raw = message.value?.toString() ?? '';
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
await firehoseConsumer.run({ eachMessage: async ({ message }) => {
  const raw = message.value?.toString() ?? '';
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

const startedAt = Date.now();
let searchHits = 0;
let inboundPending = Number.POSITIVE_INFINITY;
while (Date.now() - startedAt < timeoutMs) {
  await os.indices.refresh({ index: 'public-content-v1' }).catch(() => undefined);
  const response: any = await os.search({
    index: 'public-content-v1',
    body: { size: 0, query: { match_phrase: { text: marker } } },
  }).catch(() => null);
  searchHits = Number(response?.body?.hits?.total?.value ?? 0);
  const pendingRows = await redis.xPending('ap:queue:inbound:v1', 'sidecar-workers').catch(() => null as any);
  inboundPending = typeof pendingRows?.pending === 'number' ? pendingRows.pending : 0;
  if (searchHits === expected && stream2Matched === expected && firehoseMatched === expected && inboundPending === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

await consumer.disconnect();
await firehoseConsumer.disconnect();
await redis.quit();
await os.close();

const result = {
  ok: searchHits === expected && stream2Matched === expected && firehoseMatched === expected && inboundPending === 0,
  marker,
  expected,
  searchHits,
  stream2Matched,
  firehoseMatched,
  inboundPending,
  searchableWithinMs: Date.now() - startedAt,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
