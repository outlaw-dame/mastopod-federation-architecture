#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

const OPENSEARCH_IMAGE = process.env.OPENSEARCH_BENCH_IMAGE ?? "opensearchproject/opensearch:3.8.0";
const QDRANT_IMAGE = process.env.QDRANT_BENCH_IMAGE ?? "qdrant/qdrant:v1.19.0";
const OUTPUT = process.env.SEARCH_VECTOR_BENCH_OUTPUT ?? "../measurements/opensearch-os2/summary.json";
const DOC_COUNT = intEnv("SEARCH_VECTOR_BENCH_DOCS", 6000);
const VECTOR_DIM = intEnv("SEARCH_VECTOR_BENCH_VECTOR_DIM", 1024);
const QUERY_SAMPLES = intEnv("SEARCH_VECTOR_BENCH_QUERY_SAMPLES", 40);
const WARMUP_QUERIES = intEnv("SEARCH_VECTOR_BENCH_WARMUP_QUERIES", 8);
const BULK_DOCS = intEnv("SEARCH_VECTOR_BENCH_BULK_DOCS", 200);
const OS_PORT = intEnv("SEARCH_VECTOR_BENCH_OS_PORT", 19200);
const QDRANT_PORT = intEnv("SEARCH_VECTOR_BENCH_QDRANT_PORT", 16333);
const OS_CONTAINER = process.env.SEARCH_VECTOR_BENCH_OS_CONTAINER ?? "os2-opensearch";
const QDRANT_CONTAINER = process.env.SEARCH_VECTOR_BENCH_QDRANT_CONTAINER ?? "os2-qdrant";
const INDEX = "public-content-os2";
const COLLECTION = "public-content-os2";

const arms = [
  { id: "opensearch-lexical", openSearch: true, osVectors: false, qdrant: false },
  { id: "opensearch-vector-32x", openSearch: true, osVectors: true, qdrant: false },
  { id: "opensearch-plus-qdrant", openSearch: true, osVectors: false, qdrant: true },
];

const documents = buildDocuments(DOC_COUNT);

await main();

async function main() {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  docker(["pull", OPENSEARCH_IMAGE]);
  docker(["pull", QDRANT_IMAGE]);

  const raw = [];
  try {
    for (const arm of arms) {
      console.log(`\n=== OS2 arm: ${arm.id} ===`);
      stopAll();
      if (arm.openSearch) await startOpenSearch();
      if (arm.qdrant) await startQdrant();
      raw.push(await measureArm(arm));
    }
  } finally {
    stopAll();
  }

  const lexical = required(raw.find((row) => row.arm === "opensearch-lexical"), "lexical baseline");
  const comparisons = raw.map((row) => compare(row, lexical));
  const liveRequirementDecision = decideCurrentRuntime(raw, lexical);
  const futureVectorDecision = decideFutureVector(raw);

  const summary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    images: { openSearch: OPENSEARCH_IMAGE, qdrant: QDRANT_IMAGE },
    methodology: {
      documents: DOC_COUNT,
      vectorDimension: VECTOR_DIM,
      querySamples: QUERY_SAMPLES,
      warmupQueries: WARMUP_QUERIES,
      bulkDocs: BULK_DOCS,
      freshContainersPerArm: true,
      openSearchShards: 1,
      openSearchReplicas: 0,
      openSearchRefreshDuringIngest: "-1",
      openSearchVector: { mode: "on_disk", compressionLevel: "32x" },
      qdrantVector: { originals: "on_disk", hnsw: "on_disk", scalarQuantization: "int8" },
      note: "OS2 compares whole deployment shapes. The split OpenSearch+Qdrant arm reports summed CPU/RSS/disk rather than vector-engine resources in isolation.",
    },
    raw,
    comparisons,
    decisions: {
      currentRuntime: liveRequirementDecision,
      futureVectorIfRequired: futureVectorDecision,
    },
  };

  writeFileSync(OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ comparisons, decisions: summary.decisions }, null, 2));

  if (!liveRequirementDecision.pass) {
    throw new Error(`OS2 current-runtime decision failed evidence contract: ${liveRequirementDecision.reason}`);
  }
  if (!futureVectorDecision.pass) {
    throw new Error(`OS2 future-vector evidence incomplete: ${futureVectorDecision.reason}`);
  }
}

async function measureArm(arm) {
  if (arm.openSearch) await createOpenSearchIndex(arm.osVectors);
  if (arm.qdrant) await createQdrantCollection();

  const idle = countersForArm(arm);
  const ingestStartCounters = countersForArm(arm);
  const ingestStart = performance.now();

  if (arm.openSearch) await ingestOpenSearch(arm.osVectors);
  if (arm.qdrant) await ingestQdrant();

  const ingestWallMs = performance.now() - ingestStart;
  const ingestEndCounters = countersForArm(arm);
  if (arm.openSearch) {
    await osRequest("POST", `/${INDEX}/_refresh`);
    await waitForOpenSearchDocs();
  }
  if (arm.qdrant) await waitForQdrantDocs();

  await sleep(1200);
  const postIngest = countersForArm(arm);
  const diskBytes = diskForArm(arm);

  const lexicalLatencyMs = arm.openSearch ? await measureLexicalQueries() : null;
  const filterLatencyMs = arm.qdrant ? await measureQdrantFilterQueries() : await measureOpenSearchFilterQueries();

  let vector = null;
  if (arm.osVectors) vector = await measureOpenSearchVectorQueries();
  if (arm.qdrant) vector = await measureQdrantVectorQueries();

  const result = {
    arm: arm.id,
    services: [arm.openSearch ? "opensearch" : null, arm.qdrant ? "qdrant" : null].filter(Boolean),
    documentCount: DOC_COUNT,
    ingest: {
      wallMs: round(ingestWallMs),
      docsPerSecond: round(DOC_COUNT / (ingestWallMs / 1000)),
      cpuMs: round((ingestEndCounters.cpuUsec - ingestStartCounters.cpuUsec) / 1000),
    },
    resources: {
      idleMemoryBytes: idle.memoryBytes,
      postIngestMemoryBytes: postIngest.memoryBytes,
      peakMemoryBytes: postIngest.peakMemoryBytes,
      diskBytes,
      diskBytesPerDocument: round(diskBytes / DOC_COUNT),
    },
    queries: {
      lexicalMs: lexicalLatencyMs ? percentiles(lexicalLatencyMs) : null,
      filteredCandidateMs: percentiles(filterLatencyMs),
      vector,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function startOpenSearch() {
  docker(["rm", "-f", OS_CONTAINER], { ignore: true });
  docker([
    "run", "-d", "--name", OS_CONTAINER,
    "-p", `${OS_PORT}:9200`,
    "-e", "discovery.type=single-node",
    "-e", "DISABLE_SECURITY_PLUGIN=true",
    "-e", "DISABLE_INSTALL_DEMO_CONFIG=true",
    "-e", "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m",
    "--ulimit", "memlock=-1:-1",
    "--ulimit", "nofile=65536:65536",
    OPENSEARCH_IMAGE,
  ]);
  await waitFor("OpenSearch", async () => {
    const response = await fetch(`http://127.0.0.1:${OS_PORT}/_cluster/health`);
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    if (body.status !== "yellow" && body.status !== "green") throw new Error(`status=${body.status}`);
  }, 120_000);
}

async function startQdrant() {
  docker(["rm", "-f", QDRANT_CONTAINER], { ignore: true });
  docker(["run", "-d", "--name", QDRANT_CONTAINER, "-p", `${QDRANT_PORT}:6333`, QDRANT_IMAGE]);
  await waitFor("Qdrant", async () => {
    const response = await fetch(`http://127.0.0.1:${QDRANT_PORT}/healthz`);
    if (!response.ok) throw new Error(String(response.status));
  }, 60_000);
}

async function createOpenSearchIndex(withVector) {
  const properties = {
    stableDocId: { type: "keyword" },
    canonicalContentId: { type: "keyword" },
    sourceKind: { type: "keyword" },
    protocolPresence: { type: "keyword" },
    author: {
      properties: {
        canonicalId: { type: "keyword" },
        handle: { type: "keyword" },
        displayName: { type: "text" },
      },
    },
    text: { type: "text" },
    createdAt: { type: "date" },
    langs: { type: "keyword" },
    tags: { type: "keyword" },
    hasMedia: { type: "boolean" },
    mediaCount: { type: "integer" },
    engagement: {
      properties: {
        likeCount: { type: "integer" },
        repostCount: { type: "integer" },
        replyCount: { type: "integer" },
      },
    },
    isDeleted: { type: "boolean" },
  };
  if (withVector) {
    properties.embedding = {
      type: "knn_vector",
      dimension: VECTOR_DIM,
      space_type: "cosinesimil",
      mode: "on_disk",
      compression_level: "32x",
    };
  }

  await osRequest("PUT", `/${INDEX}`, {
    settings: {
      index: {
        knn: withVector,
        number_of_shards: 1,
        number_of_replicas: 0,
        refresh_interval: "-1",
      },
    },
    mappings: {
      dynamic: "strict",
      _source: withVector ? { excludes: ["embedding"] } : undefined,
      properties,
    },
  });
}

async function createQdrantCollection() {
  await qdrantRequest("PUT", `/collections/${COLLECTION}`, {
    vectors: {
      size: VECTOR_DIM,
      distance: "Cosine",
      on_disk: true,
    },
    hnsw_config: {
      m: 16,
      ef_construct: 100,
      on_disk: true,
    },
    quantization_config: {
      scalar: {
        type: "int8",
        quantile: 0.99,
        always_ram: true,
      },
    },
  });

  for (const [field, schema] of [
    ["createdAt", "datetime"], ["tags", "keyword"], ["author.canonicalId", "keyword"],
    ["isDeleted", "bool"], ["engagement.likeCount", "integer"],
  ]) {
    await qdrantRequest("PUT", `/collections/${COLLECTION}/index`, { field_name: field, field_schema: schema });
  }
}

async function ingestOpenSearch(withVector) {
  for (let offset = 0; offset < documents.length; offset += BULK_DOCS) {
    const chunk = documents.slice(offset, offset + BULK_DOCS);
    const lines = [];
    for (const doc of chunk) {
      lines.push(JSON.stringify({ index: { _index: INDEX, _id: doc.stableDocId } }));
      lines.push(JSON.stringify(openSearchDoc(doc, withVector)));
    }
    const response = await fetch(`http://127.0.0.1:${OS_PORT}/_bulk`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: `${lines.join("\n")}\n`,
    });
    const body = await response.json();
    if (!response.ok || body.errors) {
      const firstError = body.items?.find((item) => item.index?.error)?.index?.error;
      throw new Error(`OpenSearch bulk failed: ${response.status} ${JSON.stringify(firstError ?? body)}`);
    }
  }
}

async function ingestQdrant() {
  for (let offset = 0; offset < documents.length; offset += BULK_DOCS) {
    const chunk = documents.slice(offset, offset + BULK_DOCS);
    await qdrantRequest("PUT", `/collections/${COLLECTION}/points?wait=true`, {
      points: chunk.map((doc) => ({ id: doc.numericId, vector: doc.embedding, payload: qdrantPayload(doc) })),
    });
  }
}

async function measureLexicalQueries() {
  const queries = documents.slice(0, QUERY_SAMPLES).map((doc) => doc.uniqueToken);
  const run = async (token) => osRequest("POST", `/${INDEX}/_search`, {
    size: 20,
    _source: false,
    query: {
      bool: {
        must: [{ multi_match: { query: token, fields: ["text^3", "author.displayName", "tags^2"] } }],
        filter: [{ term: { isDeleted: false } }],
      },
    },
  });
  await warmup(queries, run);
  return timedQueries(queries, run);
}

async function measureOpenSearchFilterQueries() {
  const queries = documents.slice(0, QUERY_SAMPLES).map((doc) => doc.author.canonicalId);
  const run = async (author) => osRequest("POST", `/${INDEX}/_search`, {
    size: 30,
    _source: false,
    query: { bool: { filter: [{ term: { isDeleted: false } }, { term: { "author.canonicalId": author } }] } },
    sort: [{ createdAt: "desc" }, { stableDocId: "asc" }],
  });
  await warmup(queries, run);
  return timedQueries(queries, run);
}

async function measureQdrantFilterQueries() {
  const queries = documents.slice(0, QUERY_SAMPLES).map((doc) => doc.author.canonicalId);
  const run = async (author) => qdrantRequest("POST", `/collections/${COLLECTION}/points/scroll`, {
    limit: 30,
    with_payload: false,
    with_vector: false,
    filter: { must: [{ key: "isDeleted", match: { value: false } }, { key: "author.canonicalId", match: { value: author } }] },
    order_by: { key: "createdAt", direction: "desc" },
  });
  await warmup(queries, run);
  return timedQueries(queries, run);
}

async function measureOpenSearchVectorQueries() {
  const queryDocs = documents.slice(0, QUERY_SAMPLES);
  const run = async (doc) => osRequest("POST", `/${INDEX}/_search`, {
    size: 10,
    _source: false,
    query: { knn: { embedding: { vector: doc.embedding, k: 10 } } },
  });
  await warmup(queryDocs, run);
  const latencies = [];
  let top1 = 0;
  let top10 = 0;
  for (const doc of queryDocs) {
    const start = performance.now();
    const body = await run(doc);
    latencies.push(performance.now() - start);
    const ids = (body.hits?.hits ?? []).map((hit) => String(hit._id));
    if (ids[0] === doc.stableDocId) top1 += 1;
    if (ids.includes(doc.stableDocId)) top10 += 1;
  }
  return { latencyMs: percentiles(latencies), recallAt1: round(top1 / queryDocs.length), recallAt10: round(top10 / queryDocs.length) };
}

async function measureQdrantVectorQueries() {
  const queryDocs = documents.slice(0, QUERY_SAMPLES);
  const run = async (doc) => {
    const response = await qdrantRequest("POST", `/collections/${COLLECTION}/points/query`, {
      query: doc.embedding,
      limit: 10,
      with_payload: false,
      with_vector: false,
    });
    return response;
  };
  await warmup(queryDocs, run);
  const latencies = [];
  let top1 = 0;
  let top10 = 0;
  for (const doc of queryDocs) {
    const start = performance.now();
    const body = await run(doc);
    latencies.push(performance.now() - start);
    const points = body.result?.points ?? body.result ?? [];
    const ids = points.map((point) => String(point.id));
    if (ids[0] === String(doc.numericId)) top1 += 1;
    if (ids.includes(String(doc.numericId))) top10 += 1;
  }
  return { latencyMs: percentiles(latencies), recallAt1: round(top1 / queryDocs.length), recallAt10: round(top10 / queryDocs.length) };
}

async function warmup(items, fn) {
  for (const item of items.slice(0, Math.min(WARMUP_QUERIES, items.length))) await fn(item);
}

async function timedQueries(items, fn) {
  const latencies = [];
  for (const item of items) {
    const start = performance.now();
    await fn(item);
    latencies.push(performance.now() - start);
  }
  return latencies;
}

function countersForArm(arm) {
  const services = [arm.openSearch ? OS_CONTAINER : null, arm.qdrant ? QDRANT_CONTAINER : null].filter(Boolean);
  return services.reduce((sum, container) => {
    const c = containerCounters(container);
    return {
      cpuUsec: sum.cpuUsec + c.cpuUsec,
      memoryBytes: sum.memoryBytes + c.memoryBytes,
      peakMemoryBytes: sum.peakMemoryBytes + c.peakMemoryBytes,
    };
  }, { cpuUsec: 0, memoryBytes: 0, peakMemoryBytes: 0 });
}

function containerCounters(container) {
  const cpuStat = docker(["exec", container, "sh", "-lc", "cat /sys/fs/cgroup/cpu.stat 2>/dev/null || true"]);
  const usageUsec = Number(cpuStat.match(/usage_usec\s+(\d+)/)?.[1] ?? 0);
  const memoryCurrent = Number(docker(["exec", container, "sh", "-lc", "cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0"]).trim()) || 0;
  const memoryPeak = Number(docker(["exec", container, "sh", "-lc", "cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0"]).trim()) || memoryCurrent;
  return { cpuUsec: usageUsec, memoryBytes: memoryCurrent, peakMemoryBytes: memoryPeak };
}

function diskForArm(arm) {
  let total = 0;
  if (arm.openSearch) total += Number(docker(["exec", OS_CONTAINER, "sh", "-lc", "du -sb /usr/share/opensearch/data 2>/dev/null | awk '{print $1}'"]).trim()) || 0;
  if (arm.qdrant) total += Number(docker(["exec", QDRANT_CONTAINER, "sh", "-lc", "du -sb /qdrant/storage 2>/dev/null | awk '{print $1}'"]).trim()) || 0;
  return total;
}

function compare(row, lexical) {
  return {
    arm: row.arm,
    vsLexical: {
      ingestCpu: ratio(row.ingest.cpuMs, lexical.ingest.cpuMs),
      ingestThroughput: ratio(row.ingest.docsPerSecond, lexical.ingest.docsPerSecond),
      idleMemory: ratio(row.resources.idleMemoryBytes, lexical.resources.idleMemoryBytes),
      postIngestMemory: ratio(row.resources.postIngestMemoryBytes, lexical.resources.postIngestMemoryBytes),
      peakMemory: ratio(row.resources.peakMemoryBytes, lexical.resources.peakMemoryBytes),
      disk: ratio(row.resources.diskBytes, lexical.resources.diskBytes),
      lexicalP95: row.queries.lexicalMs ? ratio(row.queries.lexicalMs.p95, lexical.queries.lexicalMs.p95) : null,
      filterP95: ratio(row.queries.filteredCandidateMs.p95, lexical.queries.filteredCandidateMs.p95),
    },
  };
}

function decideCurrentRuntime(rows, lexical) {
  if (!lexical.queries.lexicalMs || lexical.queries.lexicalMs.p99 <= 0 || lexical.resources.diskBytes <= 0) {
    return { pass: false, selected: null, reason: "lexical baseline missing valid query/disk evidence" };
  }
  return {
    pass: true,
    selected: "opensearch-lexical",
    reason: "Current master has no live semantic/vector query consumer. The lowest-complexity architecture that satisfies proven runtime requirements is therefore lexical/faceted OpenSearch without vector storage. Vector arms are characterization evidence for a future semantic feature, not a reason to pay an always-on cost now.",
  };
}

function decideFutureVector(rows) {
  const os = rows.find((row) => row.arm === "opensearch-vector-32x");
  const split = rows.find((row) => row.arm === "opensearch-plus-qdrant");
  if (!os?.queries.vector || !split?.queries.vector) return { pass: false, selected: null, reason: "missing vector evidence" };
  for (const row of [os, split]) {
    if (row.queries.vector.recallAt10 < 0.95) return { pass: false, selected: null, reason: `${row.arm} recall@10 below 0.95` };
    if (row.queries.vector.latencyMs.p99 <= 0) return { pass: false, selected: null, reason: `${row.arm} invalid p99` };
  }

  const osCost = normalizedFutureCost(os);
  const splitCost = normalizedFutureCost(split);
  const selected = osCost <= splitCost ? os.arm : split.arm;
  return {
    pass: true,
    selected,
    reason: "Future-vector recommendation is advisory only. Both candidates must first pass recall; the lower normalized whole-deployment resource footprint is then preferred, with service-count/operational complexity breaking near ties.",
    normalizedResourceCost: { [os.arm]: round(osCost), [split.arm]: round(splitCost) },
  };
}

function normalizedFutureCost(row) {
  const gib = 1024 ** 3;
  const memoryGiB = row.resources.postIngestMemoryBytes / gib;
  const diskGiB = row.resources.diskBytes / gib;
  const cpuSeconds = row.ingest.cpuMs / 1000;
  const servicePenalty = Math.max(0, row.services.length - 1) * 0.10;
  return memoryGiB + diskGiB * 0.25 + cpuSeconds * 0.01 + servicePenalty;
}

async function waitForOpenSearchDocs() {
  await waitFor("OpenSearch document count", async () => {
    const body = await osRequest("GET", `/${INDEX}/_count`);
    if (body.count !== DOC_COUNT) throw new Error(`count=${body.count}`);
  }, 60_000);
}

async function waitForQdrantDocs() {
  await waitFor("Qdrant document count", async () => {
    const body = await qdrantRequest("POST", `/collections/${COLLECTION}/points/count`, { exact: true });
    if (body.result?.count !== DOC_COUNT) throw new Error(`count=${body.result?.count}`);
  }, 60_000);
}

async function osRequest(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${OS_PORT}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`OpenSearch ${method} ${path} failed: ${response.status} ${text.slice(0, 1200)}`);
  return parsed;
}

async function qdrantRequest(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${QDRANT_PORT}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`Qdrant ${method} ${path} failed: ${response.status} ${text.slice(0, 1200)}`);
  return parsed;
}

function buildDocuments(count) {
  const docs = [];
  const kinds = ["short", "reply", "media", "article"];
  const tags = ["fediverse", "activitypub", "atproto", "solid", "music", "sports", "science", "books"];
  for (let i = 0; i < count; i += 1) {
    const kind = kinds[i % kinds.length];
    const authorId = `acct-${i % 300}`;
    const token = `unique-${i.toString(36)}`;
    const tag = tags[i % tags.length];
    const repeat = kind === "article" ? 70 : kind === "media" ? 18 : 5;
    const text = `${token} ${tag} ${"federated social content public activity ".repeat(repeat)}`.trim();
    docs.push({
      numericId: i + 1,
      stableDocId: `doc-${i + 1}`,
      canonicalContentId: `https://example.test/content/${i + 1}`,
      sourceKind: i % 4 === 0 ? "local" : "remote",
      protocolPresence: i % 3 === 0 ? ["activitypub", "atproto"] : [i % 2 === 0 ? "activitypub" : "atproto"],
      author: { canonicalId: authorId, handle: `user${i % 300}.example.test`, displayName: `Example User ${i % 300}` },
      text,
      uniqueToken: token,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      langs: [i % 5 === 0 ? "es" : "en"],
      tags: [tag, tags[(i + 3) % tags.length]],
      hasMedia: kind === "media",
      mediaCount: kind === "media" ? 2 : 0,
      engagement: { likeCount: (i * 17) % 1000, repostCount: (i * 7) % 200, replyCount: (i * 11) % 120 },
      isDeleted: false,
      embedding: deterministicVector(i + 1, VECTOR_DIM),
    });
  }
  return docs;
}

function deterministicVector(seed, dimensions) {
  const vector = new Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) {
    const hash = createHash("sha256").update(`${seed}:${i}`).digest();
    vector[i] = (hash.readUInt32BE(0) / 0xffffffff) * 2 - 1;
  }
  let norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) norm = 1;
  return vector.map((value) => Number((value / norm).toFixed(7)));
}

function openSearchDoc(doc, withVector) {
  const { numericId: _numericId, uniqueToken: _uniqueToken, embedding, ...payload } = doc;
  return withVector ? { ...payload, embedding } : payload;
}

function qdrantPayload(doc) {
  const { numericId: _numericId, uniqueToken: _uniqueToken, embedding: _embedding, ...payload } = doc;
  return payload;
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(1000);
    }
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

function stopAll() {
  docker(["rm", "-f", OS_CONTAINER], { ignore: true });
  docker(["rm", "-f", QDRANT_CONTAINER], { ignore: true });
}

function docker(args, { ignore = false } = {}) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (ignore) return "";
    const stderr = error?.stderr?.toString?.() ?? "";
    throw new Error(`docker ${args.join(" ")} failed: ${stderr || error.message}`);
  }
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function ratio(value, baseline) {
  return baseline > 0 ? round(value / baseline) : null;
}

function round(value) {
  return Number(Number(value).toFixed(4));
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function required(value, label) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
