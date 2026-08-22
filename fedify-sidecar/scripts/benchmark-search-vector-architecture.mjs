#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

const OS_IMAGE = process.env.OPENSEARCH_BENCH_IMAGE ?? "opensearchproject/opensearch:3.8.0";
const Q_IMAGE = process.env.QDRANT_BENCH_IMAGE ?? "qdrant/qdrant:v1.19.0";
const OUTPUT = process.env.SEARCH_VECTOR_BENCH_OUTPUT ?? "../measurements/opensearch-os2/summary.json";
const DOCS = envInt("SEARCH_VECTOR_BENCH_DOCS", 6000);
const DIM = envInt("SEARCH_VECTOR_BENCH_VECTOR_DIM", 1024);
const QUERIES = envInt("SEARCH_VECTOR_BENCH_QUERY_SAMPLES", 40);
const RECALL_QUERIES = envInt("SEARCH_VECTOR_BENCH_RECALL_SAMPLES", 16);
const REPEATS = envInt("SEARCH_VECTOR_BENCH_REPEATS", 3);
const BULK = envInt("SEARCH_VECTOR_BENCH_BULK_DOCS", 200);
const OS_PORT = envInt("SEARCH_VECTOR_BENCH_OS_PORT", 19200);
const Q_PORT = envInt("SEARCH_VECTOR_BENCH_QDRANT_PORT", 16333);
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
const recallDocs = documents.slice(0, RECALL_QUERIES);
const groundTruth = new Map(recallDocs.map((doc) => [doc.stableDocId, bruteTopK(doc.embedding, 10)]));

await main();

async function main() {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  docker(["pull", OS_IMAGE]);
  docker(["pull", Q_IMAGE]);
  const raw = [];
  try {
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      for (const arm of arms) {
        stopAll();
        console.log(`\n=== repeat ${repeat}/${REPEATS}; ${arm.id} ===`);
        if (arm.os) await startOpenSearch();
        if (arm.qdrant) await startQdrant();
        raw.push(await measure(repeat, arm));
      }
    }
  } finally {
    stopAll();
  }

  const results = arms.map((arm) => medianArm(arm.id, raw));
  const lexical = must(results.find((r) => r.arm === "opensearch-lexical"), "lexical baseline");
  const comparisons = results.map((r) => compare(r, lexical));
  const currentRuntime = currentDecision(lexical);
  const futureVector = futureDecision(results);
  const summary = {
    version: 3,
    generatedAt: new Date().toISOString(),
    images: { openSearch: OS_IMAGE, qdrant: Q_IMAGE },
    methodology: {
      documents: DOCS,
      vectorDimension: DIM,
      repeats: REPEATS,
      querySamples: QUERIES,
      recallSamples: RECALL_QUERIES,
      freshContainersPerArmPerRepeat: true,
      wholeDeploymentAccounting: true,
      steadyState: {
        openSearchForceMergeMaxSegments: 1,
        qdrantWaitsForGreenOptimizerAndBoundedSegmentCount: true,
      },
      openSearch: { shards: 1, replicas: 0, refreshDuringIngest: "-1", vectorMode: "on_disk", vectorCompression: "32x" },
      qdrant: { originals: "on_disk", hnsw: "on_disk", scalarQuantization: "int8" },
      annCorrectness: "Mean top-10 overlap against brute-force cosine ground truth plus exact-self top-1 check.",
      decisionPolicy: "Current requirements choose the simplest architecture satisfying live call sites. Future vector candidates must pass ANN correctness and are compared as a Pareto frontier without an arbitrary weighted cost score.",
    },
    raw,
    results,
    comparisons,
    decisions: { currentRuntime, futureVector },
  };
  writeFileSync(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ results, comparisons, decisions: summary.decisions }, null, 2));
  if (!currentRuntime.pass) throw new Error(currentRuntime.reason);
  if (!futureVector.pass) throw new Error(futureVector.reason);
}

async function measure(repeat, arm) {
  if (arm.os) await createOsIndex(arm.osVector);
  if (arm.qdrant) await createQCollection();
  await sleep(800);
  const idle = counters(arm);
  const before = counters(arm);
  const started = performance.now();
  if (arm.os) await ingestOs(arm.osVector);
  if (arm.qdrant) await ingestQ();
  const wallMs = performance.now() - started;
  const after = counters(arm);

  if (arm.os) await settleOs();
  if (arm.qdrant) await settleQdrant();
  await sleep(1000);
  const settled = counters(arm);

  const lexical = arm.os ? await lexicalQueries() : null;
  const filtered = arm.qdrant ? await qFilterQueries() : await osFilterQueries();
  let vector = null;
  if (arm.osVector) vector = await osVectorQueries();
  if (arm.qdrant) vector = await qVectorQueries();

  const row = {
    repeat,
    arm: arm.id,
    services: [arm.os ? "opensearch" : null, arm.qdrant ? "qdrant" : null].filter(Boolean),
    ingest: { wallMs: round(wallMs), docsPerSecond: round(DOCS / (wallMs / 1000)), serviceCpuMs: round((after.cpuUsec - before.cpuUsec) / 1000) },
    resources: { idleMemoryBytes: idle.memoryBytes, settledMemoryBytes: settled.memoryBytes, peakMemoryBytes: settled.peakMemoryBytes, diskBytes: disk(arm) },
    query: { lexicalMs: lexical ? pct(lexical) : null, filteredCandidateMs: pct(filtered), vector },
  };
  console.log(JSON.stringify(row));
  return row;
}

async function startOpenSearch() {
  docker(["rm", "-f", OS_CONTAINER], { ignore: true });
  docker(["run", "-d", "--name", OS_CONTAINER, "-p", `${OS_PORT}:9200`,
    "-e", "discovery.type=single-node", "-e", "DISABLE_SECURITY_PLUGIN=true", "-e", "DISABLE_INSTALL_DEMO_CONFIG=true",
    "-e", "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m", "--ulimit", "memlock=-1:-1", "--ulimit", "nofile=65536:65536", OS_IMAGE]);
  await waitFor("OpenSearch", async () => {
    const r = await fetch(`http://127.0.0.1:${OS_PORT}/_cluster/health`); if (!r.ok) throw new Error(String(r.status));
    const b = await r.json(); if (!["yellow", "green"].includes(b.status)) throw new Error(String(b.status));
  }, 120_000);
}

async function startQdrant() {
  docker(["rm", "-f", Q_CONTAINER], { ignore: true });
  docker(["run", "-d", "--name", Q_CONTAINER, "-p", `${Q_PORT}:6333`, Q_IMAGE]);
  await waitFor("Qdrant", async () => { const r = await fetch(`http://127.0.0.1:${Q_PORT}/healthz`); if (!r.ok) throw new Error(String(r.status)); }, 60_000);
}

async function createOsIndex(vector) {
  const properties = {
    stableDocId: { type: "keyword" }, canonicalContentId: { type: "keyword" }, sourceKind: { type: "keyword" }, protocolPresence: { type: "keyword" },
    author: { properties: { canonicalId: { type: "keyword" }, handle: { type: "keyword" }, displayName: { type: "text" } } },
    text: { type: "text" }, createdAt: { type: "date" }, langs: { type: "keyword" }, tags: { type: "keyword" }, hasMedia: { type: "boolean" }, mediaCount: { type: "integer" },
    engagement: { properties: { likeCount: { type: "integer" }, repostCount: { type: "integer" }, replyCount: { type: "integer" } } }, isDeleted: { type: "boolean" },
  };
  if (vector) properties.embedding = { type: "knn_vector", dimension: DIM, space_type: "cosinesimil", mode: "on_disk", compression_level: "32x" };
  await os("PUT", `/${INDEX}`, { settings: { index: { knn: vector, number_of_shards: 1, number_of_replicas: 0, refresh_interval: "-1" } }, mappings: { dynamic: "strict", ...(vector ? { _source: { excludes: ["embedding"] } } : {}), properties } });
}

async function createQCollection() {
  await q("PUT", `/collections/${COLLECTION}`, {
    vectors: { size: DIM, distance: "Cosine", on_disk: true },
    hnsw_config: { m: 16, ef_construct: 100, on_disk: true },
    quantization_config: { scalar: { type: "int8", quantile: 0.99, always_ram: true } },
  });
  for (const [field, schema] of [["createdAt", "datetime"], ["author.canonicalId", "keyword"], ["tags", "keyword"], ["isDeleted", "bool"], ["engagement.likeCount", "integer"]]) {
    await q("PUT", `/collections/${COLLECTION}/index`, { field_name: field, field_schema: schema });
  }
}

async function ingestOs(withVector) {
  for (let i = 0; i < documents.length; i += BULK) {
    const lines = [];
    for (const doc of documents.slice(i, i + BULK)) { lines.push(JSON.stringify({ index: { _index: INDEX, _id: doc.stableDocId } })); lines.push(JSON.stringify(osDoc(doc, withVector))); }
    const r = await fetch(`http://127.0.0.1:${OS_PORT}/_bulk`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: `${lines.join("\n")}\n` });
    const b = await r.json(); if (!r.ok || b.errors) throw new Error(`OpenSearch bulk failed ${r.status}: ${JSON.stringify(b.items?.find((x) => x.index?.error)?.index?.error ?? b).slice(0, 1000)}`);
  }
}

async function ingestQ() {
  for (let i = 0; i < documents.length; i += BULK) {
    const points = documents.slice(i, i + BULK).map((doc) => ({ id: doc.numericId, vector: doc.embedding, payload: qPayload(doc) }));
    await q("PUT", `/collections/${COLLECTION}/points?wait=true`, { points });
  }
}

async function settleOs() {
  await os("POST", `/${INDEX}/_refresh`);
  await waitFor("OpenSearch count", async () => { const b = await os("GET", `/${INDEX}/_count`); if (b.count !== DOCS) throw new Error(`count=${b.count}`); }, 60_000);
  await os("POST", `/${INDEX}/_forcemerge?max_num_segments=1`);
  await os("POST", `/${INDEX}/_flush`);
}

async function settleQdrant() {
  await waitFor("Qdrant count", async () => { const b = await q("POST", `/collections/${COLLECTION}/points/count`, { exact: true }); if (b.result?.count !== DOCS) throw new Error(`count=${b.result?.count}`); }, 60_000);
  await waitFor("Qdrant optimizer convergence", async () => {
    const b = await q("GET", `/collections/${COLLECTION}`); const r = b.result ?? {};
    if (r.status !== "green") throw new Error(`status=${r.status}`);
    if (r.optimizer_status !== "ok") throw new Error(`optimizer=${JSON.stringify(r.optimizer_status)}`);
    if ((r.segments_count ?? 999) > 4) throw new Error(`segments=${r.segments_count}`);
  }, 90_000);
}

async function lexicalQueries() { return timed(documents.slice(0, QUERIES), (doc) => os("POST", `/${INDEX}/_search`, { size: 20, _source: false, query: { bool: { must: [{ multi_match: { query: doc.uniqueToken, fields: ["text^3", "author.displayName", "tags^2"] } }], filter: [{ term: { isDeleted: false } }] } } })); }
async function osFilterQueries() { return timed(documents.slice(0, QUERIES), (doc) => os("POST", `/${INDEX}/_search`, { size: 30, _source: false, query: { bool: { filter: [{ term: { isDeleted: false } }, { term: { "author.canonicalId": doc.author.canonicalId } }] } }, sort: [{ createdAt: "desc" }, { stableDocId: "asc" }] })); }
async function qFilterQueries() { return timed(documents.slice(0, QUERIES), (doc) => q("POST", `/collections/${COLLECTION}/points/scroll`, { limit: 30, with_payload: false, with_vector: false, filter: { must: [{ key: "isDeleted", match: { value: false } }, { key: "author.canonicalId", match: { value: doc.author.canonicalId } }] }, order_by: { key: "createdAt", direction: "desc" } })); }

async function osVectorQueries() {
  const lat = []; let selfTop1 = 0; let overlap = 0;
  for (const doc of recallDocs.slice(0, 6)) await osVec(doc);
  for (const doc of recallDocs) {
    const t = performance.now(); const b = await osVec(doc); lat.push(performance.now() - t);
    const ids = (b.hits?.hits ?? []).map((hit) => String(hit._id)); if (ids[0] === doc.stableDocId) selfTop1++;
    overlap += recallOverlap(ids, groundTruth.get(doc.stableDocId));
  }
  return { latencyMs: pct(lat), exactSelfTop1Rate: round(selfTop1 / recallDocs.length), annRecallAt10: round(overlap / recallDocs.length) };
}
async function osVec(doc) { return os("POST", `/${INDEX}/_search`, { size: 10, _source: false, query: { knn: { embedding: { vector: doc.embedding, k: 10 } } } }); }

async function qVectorQueries() {
  const lat = []; let selfTop1 = 0; let overlap = 0;
  for (const doc of recallDocs.slice(0, 6)) await qVec(doc);
  for (const doc of recallDocs) {
    const t = performance.now(); const b = await qVec(doc); lat.push(performance.now() - t);
    const points = b.result?.points ?? b.result ?? []; const stableIds = points.map((p) => `doc-${p.id}`); if (stableIds[0] === doc.stableDocId) selfTop1++;
    overlap += recallOverlap(stableIds, groundTruth.get(doc.stableDocId));
  }
  return { latencyMs: pct(lat), exactSelfTop1Rate: round(selfTop1 / recallDocs.length), annRecallAt10: round(overlap / recallDocs.length) };
}
async function qVec(doc) { return q("POST", `/collections/${COLLECTION}/points/query`, { query: doc.embedding, limit: 10, with_payload: false, with_vector: false }); }

async function timed(items, fn) { for (const x of items.slice(0, 8)) await fn(x); const out = []; for (const x of items) { const t = performance.now(); await fn(x); out.push(performance.now() - t); } return out; }

function bruteTopK(query, k) {
  return documents.map((doc) => ({ id: doc.stableDocId, score: dot(query, doc.embedding) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k).map((x) => x.id);
}
function dot(a, b) { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; }
function recallOverlap(actual, expected) { const wanted = new Set(expected ?? []); if (!wanted.size) return 0; let hits = 0; for (const id of actual) if (wanted.has(id)) hits++; return hits / wanted.size; }

function medianArm(id, raw) {
  const rows = raw.filter((r) => r.arm === id); if (rows.length !== REPEATS) throw new Error(`${id} repeats=${rows.length}`);
  const first = rows[0];
  return {
    arm: id, services: first.services, repeats: rows.length,
    ingest: { wallMs: med(rows.map((r) => r.ingest.wallMs)), docsPerSecond: med(rows.map((r) => r.ingest.docsPerSecond)), serviceCpuMs: med(rows.map((r) => r.ingest.serviceCpuMs)) },
    resources: { idleMemoryBytes: med(rows.map((r) => r.resources.idleMemoryBytes)), settledMemoryBytes: med(rows.map((r) => r.resources.settledMemoryBytes)), peakMemoryBytes: med(rows.map((r) => r.resources.peakMemoryBytes)), diskBytes: med(rows.map((r) => r.resources.diskBytes)) },
    query: {
      lexicalMs: first.query.lexicalMs ? medianPct(rows.map((r) => r.query.lexicalMs)) : null,
      filteredCandidateMs: medianPct(rows.map((r) => r.query.filteredCandidateMs)),
      vector: first.query.vector ? {
        latencyMs: medianPct(rows.map((r) => r.query.vector.latencyMs)),
        exactSelfTop1Rate: med(rows.map((r) => r.query.vector.exactSelfTop1Rate)),
        annRecallAt10: med(rows.map((r) => r.query.vector.annRecallAt10)),
      } : null,
    },
  };
}
function medianPct(values) { return { p50: med(values.map((v) => v.p50)), p95: med(values.map((v) => v.p95)), p99: med(values.map((v) => v.p99)), max: med(values.map((v) => v.max)) }; }

function currentDecision(lexical) {
  const pass = lexical.resources.diskBytes > 0 && lexical.query.lexicalMs?.p99 > 0 && lexical.query.filteredCandidateMs.p99 > 0;
  return { pass, selected: pass ? "opensearch-lexical" : null, reason: pass ? "Current master has no live semantic/vector query consumer. Lexical/faceted OpenSearch is the simplest measured deployment satisfying current runtime requirements." : "Lexical evidence incomplete." };
}
function futureDecision(results) {
  const candidates = results.filter((r) => r.query.vector); if (candidates.length !== 2) return { pass: false, selected: null, reason: "Expected two vector candidates." };
  for (const r of candidates) {
    if (r.query.vector.exactSelfTop1Rate < 0.95) return { pass: false, selected: null, reason: `${r.arm} exact-self top1 below 0.95.` };
    if (r.query.vector.annRecallAt10 < 0.90) return { pass: false, selected: null, reason: `${r.arm} brute-force ANN recall@10 below 0.90.` };
  }
  const frontier = candidates.filter((c) => !candidates.some((o) => o.arm !== c.arm && dominates(o, c))).map((r) => r.arm);
  return { pass: true, selected: frontier.length === 1 ? frontier[0] : null, paretoFrontier: frontier, reason: frontier.length === 1 ? `${frontier[0]} dominates the other correctness-eligible future-vector deployment in measured objectives.` : "No future-vector deployment dominates; preserve the Pareto frontier until a concrete semantic feature supplies real SLO/cost weights." };
}
function dominates(a, b) { const am = [a.resources.settledMemoryBytes, a.resources.diskBytes, a.ingest.serviceCpuMs, a.query.vector.latencyMs.p99, a.services.length]; const bm = [b.resources.settledMemoryBytes, b.resources.diskBytes, b.ingest.serviceCpuMs, b.query.vector.latencyMs.p99, b.services.length]; return am.every((v, i) => v <= bm[i]) && am.some((v, i) => v < bm[i]); }
function compare(r, b) { return { arm: r.arm, vsLexical: { ingestCpu: ratio(r.ingest.serviceCpuMs, b.ingest.serviceCpuMs), ingestThroughput: ratio(r.ingest.docsPerSecond, b.ingest.docsPerSecond), idleMemory: ratio(r.resources.idleMemoryBytes, b.resources.idleMemoryBytes), settledMemory: ratio(r.resources.settledMemoryBytes, b.resources.settledMemoryBytes), peakMemory: ratio(r.resources.peakMemoryBytes, b.resources.peakMemoryBytes), disk: ratio(r.resources.diskBytes, b.resources.diskBytes), lexicalP95: r.query.lexicalMs ? ratio(r.query.lexicalMs.p95, b.query.lexicalMs.p95) : null, filteredP95: ratio(r.query.filteredCandidateMs.p95, b.query.filteredCandidateMs.p95) } }; }

function counters(arm) { return [arm.os ? OS_CONTAINER : null, arm.qdrant ? Q_CONTAINER : null].filter(Boolean).reduce((s, name) => { const c = cc(name); return { cpuUsec: s.cpuUsec + c.cpuUsec, memoryBytes: s.memoryBytes + c.memoryBytes, peakMemoryBytes: s.peakMemoryBytes + c.peakMemoryBytes }; }, { cpuUsec: 0, memoryBytes: 0, peakMemoryBytes: 0 }); }
function cc(name) { const stat = docker(["exec", name, "sh", "-lc", "cat /sys/fs/cgroup/cpu.stat 2>/dev/null || true"]); const cpuUsec = Number(stat.match(/usage_usec\s+(\d+)/)?.[1] ?? 0); const memoryBytes = Number(docker(["exec", name, "sh", "-lc", "cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0"]).trim()) || 0; const peakMemoryBytes = Number(docker(["exec", name, "sh", "-lc", "cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0"]).trim()) || memoryBytes; return { cpuUsec, memoryBytes, peakMemoryBytes }; }
function disk(arm) { let n = 0; if (arm.os) n += Number(docker(["exec", OS_CONTAINER, "sh", "-lc", "du -sb /usr/share/opensearch/data | awk '{print $1}'"]).trim()) || 0; if (arm.qdrant) n += Number(docker(["exec", Q_CONTAINER, "sh", "-lc", "du -sb /qdrant/storage | awk '{print $1}'"]).trim()) || 0; return n; }

function buildDocuments(count) { const tags = ["fediverse", "activitypub", "atproto", "solid", "music", "sports", "science", "books"]; return Array.from({ length: count }, (_, i) => { const kind = i % 4, repeat = kind === 3 ? 70 : kind === 2 ? 18 : 5, tag = tags[i % tags.length]; return { numericId: i + 1, stableDocId: `doc-${i + 1}`, canonicalContentId: `https://example.test/content/${i + 1}`, sourceKind: i % 4 === 0 ? "local" : "remote", protocolPresence: i % 3 === 0 ? ["activitypub", "atproto"] : [i % 2 === 0 ? "activitypub" : "atproto"], author: { canonicalId: `acct-${i % 300}`, handle: `user${i % 300}.example.test`, displayName: `Example User ${i % 300}` }, uniqueToken: `unique-${i.toString(36)}`, text: `unique-${i.toString(36)} ${tag} ${"federated public social content ".repeat(repeat)}`, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), langs: [i % 5 === 0 ? "es" : "en"], tags: [tag, tags[(i + 3) % tags.length]], hasMedia: kind === 2, mediaCount: kind === 2 ? 2 : 0, engagement: { likeCount: (i * 17) % 1000, repostCount: (i * 7) % 200, replyCount: (i * 11) % 120 }, isDeleted: false, embedding: makeVector(i + 1) }; }); }
function makeVector(seed) { const v = Array.from({ length: DIM }, (_, i) => { const h = createHash("sha256").update(`${seed}:${i}`).digest(); return (h.readUInt32BE(0) / 0xffffffff) * 2 - 1; }); const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => Number((x / norm).toFixed(7))); }
function osDoc(doc, vector) { const { numericId, uniqueToken, embedding, ...p } = doc; void numericId; void uniqueToken; return vector ? { ...p, embedding } : p; }
function qPayload(doc) { const { numericId, uniqueToken, embedding, ...p } = doc; void numericId; void uniqueToken; void embedding; return p; }

async function os(method, path, body) { return req(`http://127.0.0.1:${OS_PORT}${path}`, method, body, "OpenSearch"); }
async function q(method, path, body) { return req(`http://127.0.0.1:${Q_PORT}${path}`, method, body, "Qdrant"); }
async function req(url, method, body, label) { const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; } if (!r.ok) throw new Error(`${label} ${method} failed ${r.status}: ${text.slice(0, 1000)}`); return parsed; }
async function waitFor(label, fn, timeout) { const end = Date.now() + timeout; let last = "not ready"; while (Date.now() < end) { try { await fn(); return; } catch (e) { last = e instanceof Error ? e.message : String(e); await sleep(1000); } } throw new Error(`${label} timed out: ${last}`); }
function stopAll() { docker(["rm", "-f", OS_CONTAINER], { ignore: true }); docker(["rm", "-f", Q_CONTAINER], { ignore: true }); }
function docker(args, { ignore = false } = {}) { try { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { if (ignore) return ""; throw new Error(`docker ${args.join(" ")} failed: ${e?.stderr?.toString?.() || e.message}`); } }
function pct(v) { const a = [...v].sort((x, y) => x - y); return { p50: round(pc(a, .5)), p95: round(pc(a, .95)), p99: round(pc(a, .99)), max: round(a.at(-1) ?? 0) }; }
function pc(a, p) { return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] : 0; }
function med(values) { const a = [...values].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; }
function ratio(a, b) { return b > 0 ? round(a / b) : null; }
function round(v) { return Number(Number(v).toFixed(4)); }
function envInt(name, fallback) { const n = Number.parseInt(process.env[name] ?? "", 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function must(v, label) { if (!v) throw new Error(`Missing ${label}`); return v; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
