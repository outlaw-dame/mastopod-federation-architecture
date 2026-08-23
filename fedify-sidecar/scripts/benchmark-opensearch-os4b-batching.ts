import { Client } from '@opensearch-project/opensearch';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PublicContentMapping } from '../src/search/mappings/PublicContentMapping.js';

const url = process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:19200';
const containerName = process.env.OS4B_OPENSEARCH_CONTAINER ?? 'os4b-opensearch';
const docsPerArm = Number(process.env.OS4B_DOCS_PER_ARM ?? 10000);
const repeats = Number(process.env.OS4B_REPEATS ?? 3);
const client = new Client({ node: url });

type Arm = { name: string; batchSize: number };
const arms: Arm[] = [
  { name: 'individual', batchSize: 1 },
  { name: 'bulk-25', batchSize: 25 },
  { name: 'bulk-100', batchSize: 100 },
  { name: 'bulk-250', batchSize: 250 },
  { name: 'bulk-500', batchSize: 500 },
];

const percentile = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] ?? 0;
};
const median = (xs: number[]) => percentile(xs, 0.5);

function doc(i: number, prefix = 'os4b') {
  return {
    stableDocId: `${prefix}-${i}`,
    canonicalContentId: `https://example.test/posts/${prefix}-${i}`,
    protocolPresence: ['ap'],
    sourceKind: 'remote',
    ap: { objectUri: `https://example.test/posts/${prefix}-${i}`, activityUri: `https://example.test/activities/${prefix}-${i}` },
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

function containerCpuMs(): number {
  const text = execFileSync('docker', ['exec', containerName, 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' });
  const match = /^usage_usec\s+(\d+)$/m.exec(text);
  if (!match) throw new Error('unable to read OpenSearch cgroup usage_usec');
  return Number(match[1]) / 1000;
}

function appendBulkUpdate(body: any[], index: string, id: string, document: ReturnType<typeof doc>) {
  body.push({ update: { _index: index, _id: id } }, { doc: document, doc_as_upsert: true });
}

async function warmup() {
  const index = 'os4b-warmup';
  await client.indices.create({ index, body: { settings: PublicContentMapping.settings, mappings: PublicContentMapping.mappings } });
  for (let start = 0; start < 3000; start += 100) {
    const body: any[] = [];
    for (let i = start; i < start + 100; i++) appendBulkUpdate(body, index, `warm-${i}`, doc(i, 'warm'));
    const response: any = await client.bulk({ body, refresh: false });
    if (response.body?.errors) throw new Error('warmup bulk response contained item errors');
  }
  await client.indices.refresh({ index });
  await client.search({ index, body: { size: 1, query: { match: { text: 'kiwi orbit' } } } });
  await client.indices.delete({ index });
}

function armOrder(repeat: number): Arm[] {
  if (repeat % 3 === 1) return [...arms];
  if (repeat % 3 === 2) return [...arms].reverse();
  return [arms[2]!, arms[0]!, arms[4]!, arms[1]!, arms[3]!];
}

async function runArm(arm: Arm, repeat: number) {
  const index = `os4b-${arm.name}-${repeat}`.replace(/[^a-z0-9-_]/g, '-');
  await client.indices.create({ index, body: { settings: PublicContentMapping.settings, mappings: PublicContentMapping.mappings } });
  const reqLatencies: number[] = [];
  const cpu0 = process.cpuUsage();
  const osCpu0 = containerCpuMs();
  const t0 = performance.now();

  if (arm.batchSize === 1) {
    for (let i = 0; i < docsPerArm; i++) {
      const s = performance.now();
      await client.update({ index, id: `os4b-${i}`, body: { doc: doc(i), doc_as_upsert: true }, refresh: false });
      reqLatencies.push(performance.now() - s);
    }
  } else {
    for (let start = 0; start < docsPerArm; start += arm.batchSize) {
      const end = Math.min(docsPerArm, start + arm.batchSize);
      const body: any[] = [];
      for (let i = start; i < end; i++) appendBulkUpdate(body, index, `os4b-${i}`, doc(i));
      const s = performance.now();
      const response: any = await client.bulk({ body, refresh: false });
      reqLatencies.push(performance.now() - s);
      if (response.body?.errors) throw new Error(`${arm.name} bulk response contained item errors`);
    }
  }

  const elapsedMs = performance.now() - t0;
  const osCpu1 = containerCpuMs();
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

  return {
    arm: arm.name,
    batchSize: arm.batchSize,
    repeat,
    docs: docsPerArm,
    elapsedMs,
    docsPerSec: docsPerArm / (elapsedMs / 1000),
    clientCpuMs: (cpu.user + cpu.system) / 1000,
    openSearchCpuMs: Math.max(0, osCpu1 - osCpu0),
    requestP50Ms: percentile(reqLatencies, 0.5),
    requestP95Ms: percentile(reqLatencies, 0.95),
    requestP99Ms: percentile(reqLatencies, 0.99),
    storeBytes,
  };
}

function pareto<T extends { docsPerSec: number; clientCpuMs: number; openSearchCpuMs: number; requestP95Ms: number }>(rows: T[]): T[] {
  return rows.filter((candidate) => !rows.some((other) => other !== candidate
    && other.docsPerSec >= candidate.docsPerSec
    && other.clientCpuMs <= candidate.clientCpuMs
    && other.openSearchCpuMs <= candidate.openSearchCpuMs
    && other.requestP95Ms <= candidate.requestP95Ms
    && (other.docsPerSec > candidate.docsPerSec || other.clientCpuMs < candidate.clientCpuMs || other.openSearchCpuMs < candidate.openSearchCpuMs || other.requestP95Ms < candidate.requestP95Ms)));
}

try {
  const version: any = await client.info();
  if (!String(version.body?.version?.number ?? '').startsWith('3.8.')) throw new Error('OS4b requires OpenSearch 3.8.x');
  await warmup();
  const raw: any[] = [];
  for (let r = 1; r <= repeats; r++) for (const arm of armOrder(r)) raw.push(await runArm(arm, r));
  const summaries = arms.map((arm) => {
    const rows = raw.filter((r) => r.arm === arm.name);
    return {
      arm: arm.name,
      batchSize: arm.batchSize,
      docsPerSec: median(rows.map((r) => r.docsPerSec)),
      clientCpuMs: median(rows.map((r) => r.clientCpuMs)),
      openSearchCpuMs: median(rows.map((r) => r.openSearchCpuMs)),
      requestP95Ms: median(rows.map((r) => r.requestP95Ms)),
      requestP99Ms: median(rows.map((r) => r.requestP99Ms)),
      storeBytes: median(rows.map((r) => r.storeBytes)),
    };
  });
  const baseline = summaries.find((x) => x.arm === 'individual')!;
  const evaluated = summaries.map((x) => ({
    ...x,
    throughputRatio: x.docsPerSec / baseline.docsPerSec,
    clientCpuRatio: x.clientCpuMs / baseline.clientCpuMs,
    osCpuRatio: x.openSearchCpuMs / baseline.openSearchCpuMs,
    eligible: x.arm !== 'individual' && x.docsPerSec / baseline.docsPerSec >= 1.25 && x.clientCpuMs / baseline.clientCpuMs <= 1.10 && x.openSearchCpuMs / baseline.openSearchCpuMs <= 1.10,
  }));
  const eligible = evaluated.filter((x) => x.eligible);
  const frontier = pareto(eligible);
  const output = {
    openSearchVersion: version.body.version.number,
    docsPerArm,
    repeats,
    methodology: {
      operation: 'update+doc_as_upsert (matches DefaultOpenSearchClient.upsert)',
      buffering: 'none; runtime batches only records already present in a Kafka batch',
      latency: 'observed OpenSearch request latency only; no synthetic flush constant',
      warmupDocs: 3000,
      armOrder: 'rotated/reversed',
      openSearchCpu: 'container cgroup usage_usec',
    },
    raw,
    summaries: evaluated,
    pareto: frontier,
  };
  console.log(JSON.stringify(output, null, 2));
  if (frontier.length === 0) throw new Error('OS4b found no bulk candidate meeting frozen throughput/CPU gates');
} finally {
  await client.close();
}
