import { Client } from '@opensearch-project/opensearch';
import { performance } from 'node:perf_hooks';
import { PublicContentMapping } from '../src/search/mappings/PublicContentMapping.js';

const url = process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:19200';
const docsPerArm = Number(process.env.OS4B_DOCS_PER_ARM ?? 3000);
const repeats = Number(process.env.OS4B_REPEATS ?? 3);
const client = new Client({ node: url });

type Arm = { name: string; batchSize: number; flushMs: number };
const arms: Arm[] = [
  { name: 'individual', batchSize: 1, flushMs: 0 },
  { name: 'bulk-25-50ms', batchSize: 25, flushMs: 50 },
  { name: 'bulk-100-50ms', batchSize: 100, flushMs: 50 },
  { name: 'bulk-250-250ms', batchSize: 250, flushMs: 250 },
  { name: 'bulk-500-1000ms', batchSize: 500, flushMs: 1000 },
];

const percentile = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] ?? 0;
};
const median = (xs: number[]) => percentile(xs, 0.5);

function doc(i: number) {
  return {
    stableDocId: `os4b-${i}`,
    canonicalContentId: `https://example.test/posts/os4b-${i}`,
    protocolPresence: ['ap'],
    sourceKind: 'remote',
    ap: { objectUri: `https://example.test/posts/os4b-${i}`, activityUri: `https://example.test/activities/os4b-${i}` },
    author: { canonicalId: `author-${i % 200}`, apUri: `https://example.test/users/${i % 200}` },
    text: `OS4b representative public activity ${i} federation search indexing repeated social metadata kiwi orbit ${i % 37}`,
    createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    langs: ['en'],
    tags: [`tag${i % 50}`, `topic${i % 17}`],
    hasMedia: i % 5 === 0,
    mediaCount: i % 5 === 0 ? 1 : 0,
    engagement: { likeCount: i % 100, repostCount: i % 20, replyCount: i % 10 },
    isDeleted: false,
    indexedAt: new Date().toISOString(),
  };
}

async function osCpuMs(): Promise<number> {
  const r: any = await client.nodes.stats({ metric: 'process' });
  return Object.values(r.body.nodes as Record<string, any>).reduce((n: number, node: any) => n + Number(node.process?.cpu?.total_in_millis ?? 0), 0);
}

async function runArm(arm: Arm, repeat: number) {
  const index = `os4b-${arm.name}-${repeat}`.replace(/[^a-z0-9-_]/g, '-');
  await client.indices.create({ index, body: { settings: PublicContentMapping.settings, mappings: PublicContentMapping.mappings } });
  const reqLatencies: number[] = [];
  const cpu0 = process.cpuUsage();
  const osCpu0 = await osCpuMs();
  const t0 = performance.now();

  if (arm.batchSize === 1) {
    for (let i = 0; i < docsPerArm; i++) {
      const s = performance.now();
      await client.index({ index, id: `os4b-${i}`, body: doc(i), refresh: false });
      reqLatencies.push(performance.now() - s);
    }
  } else {
    for (let start = 0; start < docsPerArm; start += arm.batchSize) {
      const end = Math.min(docsPerArm, start + arm.batchSize);
      const body: any[] = [];
      for (let i = start; i < end; i++) {
        body.push({ index: { _index: index, _id: `os4b-${i}` } }, doc(i));
      }
      const s = performance.now();
      const response: any = await client.bulk({ body, refresh: false });
      const elapsed = performance.now() - s;
      reqLatencies.push(elapsed);
      if (response.body?.errors) throw new Error(`${arm.name} bulk response contained item errors`);
    }
  }

  const elapsedMs = performance.now() - t0;
  const osCpu1 = await osCpuMs();
  const cpu = process.cpuUsage(cpu0);
  await client.indices.refresh({ index });
  const count: any = await client.count({ index });
  if (Number(count.body.count) !== docsPerArm) throw new Error(`${arm.name} expected ${docsPerArm} docs, got ${count.body.count}`);
  const search: any = await client.search({ index, body: { size: 1, query: { match: { text: 'kiwi orbit' } } } });
  if ((search.body?.hits?.hits?.length ?? 0) < 1) throw new Error(`${arm.name} lexical search verification failed`);
  await client.indices.flush({ index });
  const stats: any = await client.indices.stats({ index, metric: 'store' });
  const storeBytes = Number(stats.body?._all?.primaries?.store?.size_in_bytes ?? 0);
  await client.indices.delete({ index });

  const requestP95Ms = percentile(reqLatencies, 0.95);
  return {
    arm: arm.name,
    batchSize: arm.batchSize,
    flushMs: arm.flushMs,
    repeat,
    docs: docsPerArm,
    elapsedMs,
    docsPerSec: docsPerArm / (elapsedMs / 1000),
    clientCpuMs: (cpu.user + cpu.system) / 1000,
    openSearchCpuMs: Math.max(0, osCpu1 - osCpu0),
    requestP50Ms: percentile(reqLatencies, 0.5),
    requestP95Ms,
    requestP99Ms: percentile(reqLatencies, 0.99),
    effectiveP95Ms: requestP95Ms + arm.flushMs,
    storeBytes,
  };
}

try {
  const version: any = await client.info();
  if (!String(version.body?.version?.number ?? '').startsWith('3.8.')) throw new Error(`OS4b requires OpenSearch 3.8.x`);
  const raw: any[] = [];
  for (const arm of arms) for (let r = 1; r <= repeats; r++) raw.push(await runArm(arm, r));
  const summaries = arms.map((arm) => {
    const rows = raw.filter((r) => r.arm === arm.name);
    return {
      arm: arm.name,
      batchSize: arm.batchSize,
      flushMs: arm.flushMs,
      docsPerSec: median(rows.map((r) => r.docsPerSec)),
      clientCpuMs: median(rows.map((r) => r.clientCpuMs)),
      openSearchCpuMs: median(rows.map((r) => r.openSearchCpuMs)),
      requestP95Ms: median(rows.map((r) => r.requestP95Ms)),
      effectiveP95Ms: median(rows.map((r) => r.effectiveP95Ms)),
      storeBytes: median(rows.map((r) => r.storeBytes)),
    };
  });
  const baseline = summaries.find((x) => x.arm === 'individual')!;
  const evaluated = summaries.map((x) => ({
    ...x,
    throughputRatio: x.docsPerSec / baseline.docsPerSec,
    clientCpuRatio: x.clientCpuMs / baseline.clientCpuMs,
    osCpuRatio: x.openSearchCpuMs / baseline.openSearchCpuMs,
    eligible: x.arm !== 'individual' && x.docsPerSec / baseline.docsPerSec >= 1.25 && x.clientCpuMs / baseline.clientCpuMs <= 1.10 && x.openSearchCpuMs / baseline.openSearchCpuMs <= 1.10 && x.effectiveP95Ms <= 300,
  }));
  const winner = evaluated.filter((x) => x.eligible).sort((a, b) => a.effectiveP95Ms - b.effectiveP95Ms || b.docsPerSec - a.docsPerSec)[0] ?? null;
  const output = { openSearchVersion: version.body.version.number, docsPerArm, repeats, raw, summaries: evaluated, winner };
  console.log(JSON.stringify(output, null, 2));
  if (!winner) throw new Error('OS4b found no bulk candidate meeting frozen throughput/CPU/latency gates');
} finally {
  await client.close();
}
