#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

const OS_IMAGE = process.env.OPENSEARCH_BENCH_IMAGE ?? "opensearchproject/opensearch:3.8.0";
const QDRANT_IMAGE = process.env.QDRANT_BENCH_IMAGE ?? "qdrant/qdrant:v1.19.0";
const OUTPUT = process.env.SEARCH_VECTOR_BENCH_OUTPUT ?? "../measurements/opensearch-os2/summary.json";
const DOCS = intEnv("SEARCH_VECTOR_BENCH_DOCS", 6000);
const DIM = intEnv("SEARCH_VECTOR_BENCH_VECTOR_DIM", 1024);
const QUERY_SAMPLES = intEnv("SEARCH_VECTOR_BENCH_QUERY_SAMPLES", 40);
const BULK = intEnv("SEARCH_VECTOR_BENCH_BULK_DOCS", 200);
const OS_PORT = intEnv("SEARCH_VECTOR_BENCH_OS_PORT", 19200);
const Q_PORT = intEnv("SEARCH_VECTOR_BENCH_QDRANT_PORT", 16333);
const OS_CONTAINER = "os2-opensearch";
const Q_CONTAINER = "os2-qdrant";
const INDEX = "public-content-os2";
const COLLECTION = "public-content-os2";

const arms = [
  { id: "opensearch-lexical", os: true, osVector: false, qdrant: false },
  { id: "opensearch-vector-32x", os: true, osVector: true, qdrant: false },
  { id: "opensearch-plus-qdrant", os: true, osVector: false, qdrant: true },
];
const documents = buildDocuments(DOCS);

await main();

async function main() {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  docker(["pull", OS_IMAGE]);
  docker(["pull", QDRANT_IMAGE]);
  const results = [];
  try {
    for (const arm of arms) {
      stopAll();
      console.log(`\n=== ${arm.id} ===`);
      if (arm.os) await startOpenSearch();
      if (arm.qdrant) await startQdrant();
      results.push(await measure(arm));
    }
  } finally {
    stopAll();
  }

  const lexical = must(results.find((row) => row.arm === "opensearch-lexical"), "lexical baseline");
  const comparisons = results.map((row) => compare(row, lexical));
  const currentRuntime = currentRuntimeDecision(lexical);
  const futureVector = futureVectorDecision(results);
  const summary = {
    version: 2,
    generatedAt: new Date().toISOString(),
    images: { openSearch: OS_IMAGE, qdrant: QDRANT_IMAGE },
    methodology: {
      documents: DOCS,
      vectorDimension: DIM,
      querySamples: QUERY_SAMPLES,
      freshContainersPerArm: true,
      wholeDeploymentAccounting: true,
      openSearch: { shards: 1, replicas: 0, refreshDuringIngest: "-1", vectorMode: "on_disk", vectorCompression: "32x" },
      qdrant: { originalVectors: "on_disk", hnsw: "on_disk", scalarQuantization: "int8" },
      decisionPolicy: "Current requirements choose the simplest architecture that satisfies live call sites. Future vector candidates are correctness-gated and compared as a Pareto frontier; CPU, memory, disk, latency and service count are not collapsed into an arbitrary weighted score.",
    },
    results,
    comparisons,
    decisions: { currentRuntime, futureVector },
  };
  writeFileSync(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ comparisons, decisions: summary.decisions }, null, 2));
  if (!currentRuntime.pass) throw new Error(currentRuntime.reason);
  if (!futureVector.pass) throw new Error(futureVector.reason);
}

async function measure(arm) {
  if (arm.os) await createOpenSearchIndex(arm.osVector);
  if (arm.qdrant) await createQdrantCollection();
  await sleep(750);
  const idle = counters(arm);
  const before = counters(arm);
  const start = performance.now();
  if (arm.os) await ingestOpenSearch(arm.osVector);
  if (arm.qdrant) await ingestQdrant();
  const ingestWallMs = performance.now() - start;
  const after = counters(arm);
  if (arm.os) {
    await os("POST", `/${INDEX}/_refresh`);
    await waitFor("OpenSearch count", async () => {
      const body = await os("GET", `/${INDEX}/_count`);
      if (body.count !== DOCS) throw new Error(`count=${body.count}`);
    }, 60_000);
  }
  if (arm.qdrant) {
    await waitFor("Qdrant count", async () => {
      const body = await q("POST", `/collections/${COLLECTION}/points/count`, { exact: true });
      if (body.result?.count !== DOCS) throw new Error(`count=${body.result?.count}`);
    }, 60_000);
  }
  await sleep(1200);
  const settled = counters(arm);
  const lexical = arm.os ? await lexicalQueries() : null;
  const filtered = arm.qdrant ? await qdrantFilterQueries() : await openSearchFilterQueries();
  let vector = null;
  if (arm.osVector) vector = await openSearchVectorQueries();
  if (arm.qdrant) vector = await qdrantVectorQueries();
  return {
    arm: arm.id,
    services: [arm.os ? "opensearch" : null, arm.qdrant ? "qdrant" : null].filter(Boolean),
    ingest: {
      wallMs: round(ingestWallMs),
      docsPerSecond: round(DOCS / (ingestWallMs / 1000)),
      serviceCpuMs: round((after.cpuUsec - before.cpuUsec) / 1000),
    },
    resources: {
      idleMemoryBytes: idle.memoryBytes,
      settledMemoryBytes: settled.memoryBytes,
      peakMemoryBytes: settled.peakMemoryBytes,
      diskBytes: diskBytes(arm),
    },
    query: {
      lexicalMs: lexical ? pct(lexical) : null,
      filteredCandidateMs: pct(filtered),
      vector,
    },
  };
}

async function startOpenSearch() {
  docker(["rm", "-f", OS_CONTAINER], { ignore: true });
  docker(["run", "-d", "--name", OS_CONTAINER, "-p", `${OS_PORT}:9200`,
    "-e", "discovery.type=single-node", "-e", "DISABLE_SECURITY_PLUGIN=true",
    "-e", "DISABLE_INSTALL_DEMO_CONFIG=true", "-e", "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m",
    "--ulimit", "memlock=-1:-1", "--ulimit", "nofile=65536:65536", OS_IMAGE]);
  await waitFor("OpenSearch", async () => {
    const response = await fetch(`http://127.0.0.1:${OS_PORT}/_cluster/health`);
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    if (!["yellow", "green"].includes(body.status)) throw new Error(String(body.status));
  }, 120_000);
}

async function startQdrant() {
  docker(["rm", "-f", Q_CONTAINER], { ignore: true });
  docker(["run", "-d", "--name", Q_CONTAINER, "-p", `${Q_PORT}:6333`, QDRANT_IMAGE]);
  await waitFor("Qdrant", async () => {
    const response = await fetch(`http://127.0.0.1:${Q_PORT}/healthz`);
    if (!response.ok) throw new Error(String(response.status));
  }, 60_000);
}

async function createOpenSearchIndex(vector) {
  const properties = {
    stableDocId: { type: "keyword" }, canonicalContentId: { type: "keyword" }, sourceKind: { type: "keyword" },
    protocolPresence: { type: "keyword" },
    author: { properties: { canonicalId: { type: "keyword" }, handle: { type: "keyword" }, displayName: { type: "text" } } },
    text: { type: "text" }, createdAt: { type: "date" }, langs: { type: "keyword" }, tags: { type: "keyword" },
    hasMedia: { type: "boolean" }, mediaCount: { type: "integer" },
    engagement: { properties: { likeCount: { type: "integer" }, repostCount: { type: "integer" }, replyCount: { type: "integer" } } },
    isDeleted: { type: "boolean" },
  };
  if (vector) properties.embedding = { type: "knn_vector", dimension: DIM, space_type: "cosinesimil", mode: "on_disk", compression_level: "32x" };
  await os("PUT", `/${INDEX}`, {
    settings: { index: { knn: vector, number_of_shards: 1, number_of_replicas: 0, refresh_interval: "-1" } },
    mappings: { dynamic: "strict", ...(vector ? { _source: { excludes: ["embedding"] } } : {}), properties },
  });
}

async function createQdrantCollection() {
  await q("PUT", `/collections/${COLLECTION}`, {
    vectors: { size: DIM, distance: "Cosine", on_disk: true },
    hnsw_config: { m: 16, ef_construct: 100, on_disk: true },
    quantization_config: { scalar: { type: "int8", quantile: 0.99, always_ram: true } },
  });
  for (const [field, schema] of [["createdAt", "datetime"], ["author.canonicalId", "keyword"], ["tags", "keyword"], ["isDeleted", "bool"], ["engagement.likeCount", "integer"]]) {
    await q("PUT", `/collections/${COLLECTION}/index`, { field_name: field, field_schema: schema });
  }
}

async function ingestOpenSearch(withVector) {
  for (let i = 0; i < documents.length; i += BULK) {
    const lines = [];
    for (const doc of documents.slice(i, i + BULK)) {
      lines.push(JSON.stringify({ index: { _index: INDEX, _id: doc.stableDocId } }));
      lines.push(JSON.stringify(osDoc(doc, withVector)));
    }
    const response = await fetch(`http://127.0.0.1:${OS_PORT}/_bulk`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: `${lines.join("\n")}\n` });
    const body = await response.json();
    if (!response.ok || body.errors) throw new Error(`OpenSearch bulk failed: ${response.status} ${JSON.stringify(body.items?.find((x) => x.index?.error)?.index?.error ?? body).slice(0, 1000)}`);
  }
}

async function ingestQdrant() {
  for (let i = 0; i < documents.length; i += BULK) {
    const points = documents.slice(i, i + BULK).map((doc) => ({ id: doc.numericId, vector: doc.embedding, payload: qPayload(doc) }));
    await q("PUT", `/collections/${COLLECTION}/points?wait=true`, { points });
  }
}

async function lexicalQueries() {
  const items = documents.slice(0, QUERY_SAMPLES);
  return measureQueries(items, async (doc) => os("POST", `/${INDEX}/_search`, {
    size: 20, _source: false,
    query: { bool: { must: [{ multi_match: { query: doc.uniqueToken, fields: ["text^3", "author.displayName", "tags^2"] } }], filter: [{ term: { isDeleted: false } }] } },
  }));
}

async function openSearchFilterQueries() {
  const items = documents.slice(0, QUERY_SAMPLES);
  return measureQueries(items, async (doc) => os("POST", `/${INDEX}/_search`, {
    size: 30, _source: false,
    query: { bool: { filter: [{ term: { isDeleted: false } }, { term: { "author.canonicalId": doc.author.canonicalId } }] } },
    sort: [{ createdAt: "desc" }, { stableDocId: "asc" }],
  }));
}

async function qdrantFilterQueries() {
  const items = documents.slice(0, QUERY_SAMPLES);
  return measureQueries(items, async (doc) => q("POST", `/collections/${COLLECTION}/points/scroll`, {
    limit: 30, with_payload: false, with_vector: false,
    filter: { must: [{ key: "isDeleted", match: { value: false } }, { key: "author.canonicalId", match: { value: doc.author.canonicalId } }] },
    order_by: { key: "createdAt", direction: "desc" },
  }));
}

async function openSearchVectorQueries() {
  const items = documents.slice(0, QUERY_SAMPLES);
  const latencies = []; let top1 = 0; let top10 = 0;
  for (const doc of items.slice(0, 8)) await osVector(doc);
  for (const doc of items) {
    const start = performance.now(); const body = await osVector(doc); latencies.push(performance.now() - start);
    const ids = (body.hits?.hits ?? []).map((hit) => String(hit._id));
    if (ids[0] === doc.stableDocId) top1++; if (ids.includes(doc.stableDocId)) top10++;
  }
  return { latencyMs: pct(latencies), recallAt1: round(top1 / items.length), recallAt10: round(top10 / items.length) };
}

async function osVector(doc) {
  return os("POST", `/${INDEX}/_search`, { size: 10, _source: false, query: { knn: { embedding: { vector: doc.embedding, k: 10 } } } });
}

async function qdrantVectorQueries() {
  const items = documents.slice(0, QUERY_SAMPLES);
  const latencies = []; let top1 = 0; let top10 = 0;
  for (const doc of items.slice(0, 8)) await qVector(doc);
  for (const doc of items) {
    const start = performance.now(); const body = await qVector(doc); latencies.push(performance.now() - start);
    const points = body.result?.points ?? body.result ?? []; const ids = points.map((point) => String(point.id));
    if (ids[0] === String(doc.numericId)) top1++; if (ids.includes(String(doc.numericId))) top10++;
  }
  return { latencyMs: pct(latencies), recallAt1: round(top1 / items.length), recallAt10: round(top10 / items.length) };
}

async function qVector(doc) {
  return q("POST", `/collections/${COLLECTION}/points/query`, { query: doc.embedding, limit: 10, with_payload: false, with_vector: false });
}

async function measureQueries(items, fn) {
  for (const item of items.slice(0, 8)) await fn(item);
  const values = [];
  for (const item of items) { const start = performance.now(); await fn(item); values.push(performance.now() - start); }
  return values;
}

function currentRuntimeDecision(lexical) {
  const valid = lexical.resources.diskBytes > 0 && lexical.query.lexicalMs?.p99 > 0 && lexical.query.filteredCandidateMs.p99 > 0;
  return {
    pass: valid,
    selected: valid ? "opensearch-lexical" : null,
    reason: valid
      ? "Current master has no live semantic/vector query consumer. Lexical/faceted OpenSearch is the least-complex deployment shape that satisfies proven live requirements; vectors remain optional future capability evidence."
      : "Lexical baseline evidence incomplete.",
  };
}

function futureVectorDecision(rows) {
  const candidates = rows.filter((row) => row.query.vector);
  if (candidates.length !== 2) return { pass: false, selected: null, reason: "Expected exactly two vector-capable architecture candidates." };
  for (const row of candidates) {
    if (row.query.vector.recallAt10 < 0.95) return { pass: false, selected: null, reason: `${row.arm} recall@10 below 0.95.` };
  }
  const frontier = candidates.filter((candidate) => !candidates.some((other) => other.arm !== candidate.arm && dominates(other, candidate))).map((row) => row.arm);
  return {
    pass: true,
    selected: frontier.length === 1 ? frontier[0] : null,
    paretoFrontier: frontier,
    reason: frontier.length === 1
      ? `${frontier[0]} dominates the other correctness-eligible future-vector architecture across the measured resource/latency objectives.`
      : "No single future-vector architecture dominates. Keep the measured Pareto frontier and defer a future semantic-feature choice until its workload/SLO assigns real value to the tradeoffs.",
  };
}

function dominates(a, b) {
  const aMetrics = [a.resources.settledMemoryBytes, a.resources.diskBytes, a.ingest.serviceCpuMs, a.query.vector.latencyMs.p99, a.services.length];
  const bMetrics = [b.resources.settledMemoryBytes, b.resources.diskBytes, b.ingest.serviceCpuMs, b.query.vector.latencyMs.p99, b.services.length];
  return aMetrics.every((value, i) => value <= bMetrics[i]) && aMetrics.some((value, i) => value < bMetrics[i]);
}

function compare(row, base) {
  return { arm: row.arm, vsLexical: {
    ingestCpu: ratio(row.ingest.serviceCpuMs, base.ingest.serviceCpuMs), ingestThroughput: ratio(row.ingest.docsPerSecond, base.ingest.docsPerSecond),
    idleMemory: ratio(row.resources.idleMemoryBytes, base.resources.idleMemoryBytes), settledMemory: ratio(row.resources.settledMemoryBytes, base.resources.settledMemoryBytes),
    peakMemory: ratio(row.resources.peakMemoryBytes, base.resources.peakMemoryBytes), disk: ratio(row.resources.diskBytes, base.resources.diskBytes),
    lexicalP95: row.query.lexicalMs ? ratio(row.query.lexicalMs.p95, base.query.lexicalMs.p95) : null,
    filteredP95: ratio(row.query.filteredCandidateMs.p95, base.query.filteredCandidateMs.p95),
  } };
}

function counters(arm) {
  const names = [arm.os ? OS_CONTAINER : null, arm.qdrant ? Q_CONTAINER : null].filter(Boolean);
  return names.reduce((sum, name) => { const c = containerCounters(name); return { cpuUsec: sum.cpuUsec + c.cpuUsec, memoryBytes: sum.memoryBytes + c.memoryBytes, peakMemoryBytes: sum.peakMemoryBytes + c.peakMemoryBytes }; }, { cpuUsec: 0, memoryBytes: 0, peakMemoryBytes: 0 });
}

function containerCounters(name) {
  const stat = docker(["exec", name, "sh", "-lc", "cat /sys/fs/cgroup/cpu.stat 2>/dev/null || true"]);
  const cpuUsec = Number(stat.match(/usage_usec\s+(\d+)/)?.[1] ?? 0);
  const memoryBytes = Number(docker(["exec", name, "sh", "-lc", "cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0"]).trim()) || 0;
  const peakMemoryBytes = Number(docker(["exec", name, "sh", "-lc", "cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0"]).trim()) || memoryBytes;
  return { cpuUsec, memoryBytes, peakMemoryBytes };
}

function diskBytes(arm) {
  let total = 0;
  if (arm.os) total += Number(docker(["exec", OS_CONTAINER, "sh", "-lc", "du -sb /usr/share/opensearch/data 2>/dev/null | awk '{print $1}'"]).trim()) || 0;
  if (arm.qdrant) total += Number(docker(["exec", Q_CONTAINER, "sh", "-lc", "du -sb /qdrant/storage 2>/dev/null | awk '{print $1}'"]).trim()) || 0;
  return total;
}

function buildDocuments(count) {
  const tags = ["fediverse", "activitypub", "atproto", "solid", "music", "sports", "science", "books"];
  return Array.from({ length: count }, (_, i) => {
    const kind = i % 4; const repeat = kind === 3 ? 70 : kind === 2 ? 18 : 5; const tag = tags[i % tags.length];
    return {
      numericId: i + 1, stableDocId: `doc-${i + 1}`, canonicalContentId: `https://example.test/content/${i + 1}`,
      sourceKind: i % 4 === 0 ? "local" : "remote", protocolPresence: i % 3 === 0 ? ["activitypub", "atproto"] : [i % 2 === 0 ? "activitypub" : "atproto"],
      author: { canonicalId: `acct-${i % 300}`, handle: `user${i % 300}.example.test`, displayName: `Example User ${i % 300}` },
      uniqueToken: `unique-${i.toString(36)}`, text: `unique-${i.toString(36)} ${tag} ${"federated public social content ".repeat(repeat)}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), langs: [i % 5 === 0 ? "es" : "en"], tags: [tag, tags[(i + 3) % tags.length]],
      hasMedia: kind === 2, mediaCount: kind === 2 ? 2 : 0, engagement: { likeCount: (i * 17) % 1000, repostCount: (i * 7) % 200, replyCount: (i * 11) % 120 },
      isDeleted: false, embedding: vector(i + 1),
    };
  });
}

function vector(seed) {
  const out = Array.from({ length: DIM }, (_, i) => { const h = createHash("sha256").update(`${seed}:${i}`).digest(); return (h.readUInt32BE(0) / 0xffffffff) * 2 - 1; });
  const norm = Math.sqrt(out.reduce((sum, x) => sum + x * x, 0)) || 1;
  return out.map((x) => Number((x / norm).toFixed(7)));
}

function osDoc(doc, withVector) { const { numericId, uniqueToken, embedding, ...payload } = doc; void numericId; void uniqueToken; return withVector ? { ...payload, embedding } : payload; }
function qPayload(doc) { const { numericId, uniqueToken, embedding, ...payload } = doc; void numericId; void uniqueToken; void embedding; return payload; }

async function os(method, path, body) { return request(`http://127.0.0.1:${OS_PORT}${path}`, method, body, "OpenSearch"); }
async function q(method, path, body) { return request(`http://127.0.0.1:${Q_PORT}${path}`, method, body, "Qdrant"); }
async function request(url, method, body, label) {
  const response = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`${label} ${method} ${url} failed ${response.status}: ${text.slice(0, 1000)}`);
  return parsed;
}

async function waitFor(label, fn, timeout) { const end = Date.now() + timeout; let last = "not ready"; while (Date.now() < end) { try { await fn(); return; } catch (e) { last = e instanceof Error ? e.message : String(e); await sleep(1000); } } throw new Error(`${label}: ${last}`); }
function stopAll() { docker(["rm", "-f", OS_CONTAINER], { ignore: true }); docker(["rm", "-f", Q_CONTAINER], { ignore: true }); }
function docker(args, { ignore = false } = {}) { try { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { if (ignore) return ""; throw new Error(`docker ${args.join(" ")} failed: ${e?.stderr?.toString?.() || e.message}`); } }
function pct(values) { const a = [...values].sort((x, y) => x - y); return { p50: round(percentile(a, .50)), p95: round(percentile(a, .95)), p99: round(percentile(a, .99)), max: round(a.at(-1) ?? 0) }; }
function percentile(a, p) { if (!a.length) return 0; return a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] ?? 0; }
function ratio(a, b) { return b > 0 ? round(a / b) : null; }
function round(v) { return Number(Number(v).toFixed(4)); }
function intEnv(name, fallback) { const n = Number.parseInt(process.env[name] ?? "", 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function must(v, label) { if (!v) throw new Error(`Missing ${label}`); return v; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
