import { Client } from '@opensearch-project/opensearch';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PublicContentIndexWriter } from '../src/search/writer/PublicContentIndexWriter.js';
import { DefaultOpenSearchClient } from '../src/search/writer/OpenSearchClient.js';
import { InMemorySearchDocAliasCache } from '../src/search/writer/SearchDocAliasCache.js';
import { DefaultSearchDedupService } from '../src/search/aliases/SearchDedupService.js';
import { PublicContentMapping } from '../src/search/mappings/PublicContentMapping.js';
import type { SearchPublicUpsertV1 } from '../src/search/events/SearchEvents.js';

const url = process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:19200';
const containerName = process.env.OS4B_OPENSEARCH_CONTAINER ?? 'os4b-opensearch';
const docs = Number(process.env.OS4B_WRITER_DOCS ?? 5000);
const repeats = Number(process.env.OS4B_WRITER_REPEATS ?? 3);
const batchSize = 100;
const native = new Client({ node: url });

function event(i: number): SearchPublicUpsertV1 {
  const uri = `https://remote.example/posts/${i}`;
  return {
    upsertKind: 'full',
    stableDocId: `ap:${uri}`,
    protocolSource: 'ap',
    sourceKind: 'remote',
    ap: { objectUri: uri, activityUri: `https://remote.example/activities/${i}` },
    author: {
      canonicalId: `account-${i % 300}`,
      apUri: `https://remote.example/users/${i % 300}`,
    },
    content: {
      text: `OS4b canonical writer post ${i} kiwi orbit federation indexing`,
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      langs: ['en'],
      tags: [`tag${i % 50}`],
    },
    media: { hasMedia: i % 5 === 0, mediaCount: i % 5 === 0 ? 1 : 0 },
    indexedAt: new Date().toISOString(),
  };
}

function cpuMs(): number {
  const text = execFileSync('docker', ['exec', containerName, 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' });
  const m = /^usage_usec\s+(\d+)$/m.exec(text);
  if (!m) throw new Error('missing cgroup usage_usec');
  return Number(m[1]) / 1000;
}

async function resetIndex() {
  try { await native.indices.delete({ index: 'public-content-v1' }); } catch (error: any) {
    if (error.meta?.statusCode !== 404) throw error;
  }
  await native.indices.create({
    index: 'public-content-v1',
    body: { settings: PublicContentMapping.settings, mappings: PublicContentMapping.mappings },
  });
}

async function run(mode: 'individual' | 'batch', repeat: number) {
  await resetIndex();
  const store = new DefaultOpenSearchClient(native);
  const aliases = new InMemorySearchDocAliasCache();
  const writer = new PublicContentIndexWriter(store, aliases, new DefaultSearchDedupService(aliases));
  const events = Array.from({ length: docs }, (_, i) => event(i));
  const clientCpu0 = process.cpuUsage();
  const osCpu0 = cpuMs();
  const t0 = performance.now();

  if (mode === 'individual') {
    for (const e of events) await writer.onUpsert(e);
  } else {
    for (let i = 0; i < events.length; i += batchSize) {
      await writer.onUpsertBatch(events.slice(i, i + batchSize));
    }
  }

  const elapsedMs = performance.now() - t0;
  const osCpu = cpuMs() - osCpu0;
  const clientCpu = process.cpuUsage(clientCpu0);
  await native.indices.refresh({ index: 'public-content-v1' });
  const count: any = await native.count({ index: 'public-content-v1' });
  if (Number(count.body.count) !== docs) throw new Error(`${mode} count mismatch ${count.body.count}`);
  const check = await store.get(`ap:https://remote.example/posts/${docs - 1}`);
  if (!check?.text?.includes('kiwi orbit')) throw new Error(`${mode} readback failed`);
  const alias = await aliases.getByApUri(`https://remote.example/posts/${docs - 1}`);
  if (alias !== `ap:https://remote.example/posts/${docs - 1}`) throw new Error(`${mode} alias publication failed`);

  return {
    mode,
    repeat,
    elapsedMs,
    docsPerSec: docs / (elapsedMs / 1000),
    clientCpuMs: (clientCpu.user + clientCpu.system) / 1000,
    openSearchCpuMs: osCpu,
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

try {
  const info: any = await native.info();
  if (!String(info.body?.version?.number ?? '').startsWith('3.8.')) throw new Error('requires OpenSearch 3.8.x');
  const raw: any[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const order: Array<'individual' | 'batch'> = repeat % 2 === 0 ? ['batch', 'individual'] : ['individual', 'batch'];
    for (const mode of order) raw.push(await run(mode, repeat));
  }
  const summarize = (mode: 'individual' | 'batch') => {
    const rows = raw.filter((r) => r.mode === mode);
    return {
      mode,
      docsPerSec: median(rows.map((r) => r.docsPerSec)),
      clientCpuMs: median(rows.map((r) => r.clientCpuMs)),
      openSearchCpuMs: median(rows.map((r) => r.openSearchCpuMs)),
    };
  };
  const individual = summarize('individual');
  const batch = summarize('batch');
  const comparison = {
    throughputRatio: batch.docsPerSec / individual.docsPerSec,
    clientCpuRatio: batch.clientCpuMs / individual.clientCpuMs,
    openSearchCpuRatio: batch.openSearchCpuMs / individual.openSearchCpuMs,
  };
  const pass = comparison.throughputRatio >= 1.5 && comparison.clientCpuRatio <= 0.9 && comparison.openSearchCpuRatio <= 0.9;
  console.log(JSON.stringify({ openSearchVersion: info.body.version.number, docs, repeats, batchSize, raw, individual, batch, comparison, pass }, null, 2));
  if (!pass) throw new Error('canonical writer batching did not meet frozen 1.5x throughput / 0.9x CPU gates');
} finally {
  await native.close();
}
