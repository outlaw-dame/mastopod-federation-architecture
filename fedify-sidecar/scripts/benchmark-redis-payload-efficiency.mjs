import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import * as zlib from "node:zlib";
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const OUTPUT_PATH = process.env.REDIS_PAYLOAD_BENCHMARK_OUTPUT;
const PREFIX = `ap:bench:payload-efficiency:${process.pid}:${Date.now()}`;
const MAX_REAL_REDIS_LOGICAL_BYTES = Number.parseInt(
  process.env.REDIS_PAYLOAD_BENCHMARK_MAX_LOGICAL_BYTES ?? String(160 * 1024 * 1024),
  10,
);
const CODEC_ITERATIONS = 20;

const zstdCompressSync = zlib.zstdCompressSync;
const zstdDecompressSync = zlib.zstdDecompressSync;
if (typeof zstdCompressSync !== "function" || typeof zstdDecompressSync !== "function") {
  throw new Error(
    "This evidence benchmark requires Node >=22.15 with built-in Zstd support; production remains Node >=20 and is not changed by this benchmark.",
  );
}

const ACTIVITY_SIZES = [2 * 1024, 20 * 1024, 100 * 1024];
const THEORETICAL_FANOUTS = [1, 10, 100, 1000, 10000];
const REAL_CASES = [
  { recipients: 10_000, endpoints: 10 },
  { recipients: 10_000, endpoints: 100 },
  { recipients: 10_000, endpoints: 10_000 },
  { recipients: 1_000, endpoints: 1_000 },
];

function deterministicText(targetBytes) {
  const words = [
    "activitypub", "solid", "federation", "recipient", "timeline", "conversation", "identity", "delivery",
    "semantic", "privacy", "community", "network", "article", "profile", "stream", "message", "public", "reply",
  ];
  let out = "";
  let index = 0;
  while (Buffer.byteLength(out) < targetBytes) {
    const digest = createHash("sha256").update(`payload-${index}`).digest("hex").slice(0, 12);
    out += `${words[index % words.length]}-${digest} `;
    index += 1;
  }
  return out.slice(0, targetBytes);
}

function makeActivity(targetBytes) {
  const base = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: "https://local.example/activities/payload-efficiency",
    type: "Create",
    actor: "https://local.example/users/alice",
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    object: {
      id: "https://local.example/objects/payload-efficiency",
      type: "Note",
      attributedTo: "https://local.example/users/alice",
      published: "2026-08-18T10:00:00.000Z",
      url: "https://local.example/objects/payload-efficiency",
      content: "",
    },
  };
  const skeletonBytes = Buffer.byteLength(JSON.stringify(base));
  base.object.content = deterministicText(Math.max(0, targetBytes - skeletonBytes));
  return JSON.stringify(base);
}

function makeTargets(recipients, endpoints) {
  const targets = [];
  for (let index = 0; index < recipients; index += 1) {
    const endpoint = index % endpoints;
    const domain = `server-${endpoint}.example`;
    targets.push({
      inboxUrl: `https://${domain}/users/user-${index}/inbox`,
      sharedInboxUrl: endpoints < recipients ? `https://${domain}/inbox` : undefined,
      deliveryUrl: endpoints < recipients
        ? `https://${domain}/inbox`
        : `https://${domain}/users/user-${index}/inbox`,
      targetDomain: domain,
    });
  }
  return targets;
}

function makeOutboundTargets(endpoints) {
  return Array.from({ length: endpoints }, (_, index) => ({
    targetInbox: `https://server-${index}.example/inbox`,
    targetDomain: `server-${index}.example`,
  }));
}

function percentile(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
}

function measureCodec(name, compress, decompress, input) {
  const compressed = compress(input);
  const roundTrip = decompress(compressed);
  if (!Buffer.from(roundTrip).equals(Buffer.from(input))) {
    throw new Error(`${name} codec round-trip mismatch`);
  }
  const compressMs = [];
  const decompressMs = [];
  for (let i = 0; i < CODEC_ITERATIONS; i += 1) {
    const c0 = performance.now();
    const encoded = compress(input);
    compressMs.push(performance.now() - c0);
    const d0 = performance.now();
    decompress(encoded);
    decompressMs.push(performance.now() - d0);
  }
  return {
    codec: name,
    sourceBytes: Buffer.byteLength(input),
    compressedBytes: Buffer.byteLength(compressed),
    ratio: Buffer.byteLength(input) / Math.max(1, Buffer.byteLength(compressed)),
    compressP50Ms: percentile(compressMs, 0.5),
    compressP95Ms: percentile(compressMs, 0.95),
    decompressP50Ms: percentile(decompressMs, 0.5),
    decompressP95Ms: percentile(decompressMs, 0.95),
  };
}

function codecEvidence(activity) {
  const source = Buffer.from(activity);
  return [
    measureCodec("gzip-6", value => zlib.gzipSync(value, { level: 6 }), zlib.gunzipSync, source),
    measureCodec(
      "brotli-4",
      value => zlib.brotliCompressSync(value, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
      zlib.brotliDecompressSync,
      source,
    ),
    measureCodec(
      "zstd-3",
      value => zstdCompressSync(value, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
      }),
      zstdDecompressSync,
      source,
    ),
  ];
}

function fieldBytes(fields) {
  let total = 0;
  for (const [key, value] of Object.entries(fields)) {
    total += Buffer.byteLength(key);
    total += Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(String(value));
  }
  return total;
}

function commonOutboxFields() {
  return {
    intentId: "apdm-v1-benchmark",
    activityId: "https://local.example/activities/payload-efficiency",
    actorUri: "https://local.example/users/alice",
    createdAt: "1787047200000",
    attempt: "0",
    maxAttempts: "12",
    notBeforeMs: "0",
    lastError: "",
    meta: JSON.stringify({ visibility: "public", isPublicActivity: true, searchConsent: false }),
    bridgeHints: "",
  };
}

function commonOutboundFields(index) {
  return {
    jobId: `https://local.example/activities/payload-efficiency::https://server-${index}.example/inbox`,
    activityId: "https://local.example/activities/payload-efficiency",
    actorUri: "https://local.example/users/alice",
    targetInbox: `https://server-${index}.example/inbox`,
    targetDomain: `server-${index}.example`,
    attempt: "0",
    maxAttempts: "10",
    notBeforeMs: "0",
    deferCount: "0",
    lastError: "",
    meta: JSON.stringify({ visibility: "public", isPublicActivity: true }),
  };
}

function buildLayouts({ activity, targets, endpoints }) {
  const activityBuffer = Buffer.from(activity);
  const targetsJson = JSON.stringify(targets);
  const targetsBuffer = Buffer.from(targetsJson);
  const compressedActivity = zstdCompressSync(activityBuffer, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
  const compressedTargets = zstdCompressSync(targetsBuffer, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
  const payloadRef = `sha256:${createHash("sha256").update(activityBuffer).digest("hex")}`;

  const layouts = {
    A_current: {
      payload: null,
      outbox: { ...commonOutboxFields(), activity, targets: targetsJson },
      outbound: index => ({ ...commonOutboundFields(index), activity }),
      codec: "identity",
      reference: false,
    },
    B_compressed: {
      payload: null,
      outbox: {
        ...commonOutboxFields(),
        activityEncoding: "zstd-3",
        activityPayload: compressedActivity,
        targetsEncoding: "zstd-3",
        targetsPayload: compressedTargets,
      },
      outbound: index => ({
        ...commonOutboundFields(index),
        activityEncoding: "zstd-3",
        activityPayload: compressedActivity,
      }),
      codec: "zstd-3",
      reference: false,
    },
    C_reference: {
      payload: activityBuffer,
      outbox: { ...commonOutboxFields(), activityRef: payloadRef, targets: targetsJson },
      outbound: index => ({ ...commonOutboundFields(index), activityRef: payloadRef }),
      codec: "identity",
      reference: true,
    },
    D_reference_compressed: {
      payload: compressedActivity,
      outbox: {
        ...commonOutboxFields(),
        activityRef: payloadRef,
        targetsEncoding: "zstd-3",
        targetsPayload: compressedTargets,
      },
      outbound: index => ({ ...commonOutboundFields(index), activityRef: payloadRef }),
      codec: "zstd-3",
      reference: true,
    },
  };

  for (const layout of Object.values(layouts)) {
    let logical = fieldBytes(layout.outbox);
    if (layout.payload) logical += Buffer.byteLength(layout.payload);
    for (let index = 0; index < endpoints; index += 1) logical += fieldBytes(layout.outbound(index));
    layout.logicalBytes = logical;
  }
  return layouts;
}

async function memoryUsage(client, key) {
  const result = await client.sendCommand(["MEMORY", "USAGE", key, "SAMPLES", "0"]);
  return result == null ? 0 : Number(result);
}

async function writeStreamEntries(client, key, entries) {
  const chunkSize = 250;
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const multi = client.multi();
    for (const fields of entries.slice(offset, offset + chunkSize)) {
      multi.xAdd(key, "*", fields);
    }
    await multi.exec();
  }
}

async function runLayout(client, caseId, name, layout, endpoints) {
  const base = `${PREFIX}:${caseId}:${name}`;
  const outboxKey = `${base}:outbox`;
  const outboundKey = `${base}:outbound`;
  const payloadKey = `${base}:payload`;
  const keys = [outboxKey, outboundKey];
  if (layout.payload) keys.push(payloadKey);

  const before = performance.now();
  if (layout.payload) await client.set(payloadKey, layout.payload);
  await client.xAdd(outboxKey, "*", layout.outbox);
  const outboundEntries = Array.from({ length: endpoints }, (_, index) => layout.outbound(index));
  await writeStreamEntries(client, outboundKey, outboundEntries);
  const writeMs = performance.now() - before;

  const usages = {};
  for (const key of keys) usages[key.split(":").at(-1)] = await memoryUsage(client, key);
  const redisBytes = Object.values(usages).reduce((sum, value) => sum + value, 0);

  await client.del(keys);
  return {
    variant: name,
    codec: layout.codec,
    reference: layout.reference,
    logicalFieldBytes: layout.logicalBytes,
    redisBytes,
    writeMs,
    keyMemoryBytes: usages,
  };
}

function theoreticalEvidence(activityBytes, targetsBytes, recipients, endpoints) {
  return {
    recipients,
    uniqueDeliveryEndpoints: endpoints,
    sharedInboxCollapseRatio: recipients / Math.max(1, endpoints),
    activityBytes,
    targetsBytes,
    sidecarCurrentActivityCopies: 1 + endpoints,
    sidecarCurrentActivityBytes: activityBytes * (1 + endpoints),
    crossRedisActivityCopiesIncludingBullHandoff: 2 + endpoints,
    crossRedisActivityBytesIncludingBullHandoff: activityBytes * (2 + endpoints),
    note: "Counts durable payload representations, not allocator overhead. ACKed Stream entries remain until trimming; Bull retention is separately governed.",
  };
}

async function main() {
  const client = createClient({ url: REDIS_URL });
  client.on("error", error => console.error("redis-benchmark-client", error));
  await client.connect();

  try {
    const activities = ACTIVITY_SIZES.map(target => ({ target, value: makeActivity(target) }));
    const codecs = activities.map(({ target, value }) => ({
      requestedBytes: target,
      actualBytes: Buffer.byteLength(value),
      codecs: codecEvidence(value),
    }));

    const theoretical = [];
    for (const { target, value } of activities) {
      const activityBytes = Buffer.byteLength(value);
      for (const recipients of THEORETICAL_FANOUTS) {
        for (const endpoints of [...new Set([Math.min(recipients, 10), Math.min(recipients, 100), recipients])]) {
          const targets = makeTargets(recipients, endpoints);
          theoretical.push(theoreticalEvidence(
            activityBytes,
            Buffer.byteLength(JSON.stringify(targets)),
            recipients,
            endpoints,
          ));
        }
      }
    }

    const realRedis = [];
    for (const { target, value: activity } of activities) {
      for (const testCase of REAL_CASES) {
        const targets = makeTargets(testCase.recipients, testCase.endpoints);
        const layouts = buildLayouts({ activity, targets, endpoints: testCase.endpoints });
        const currentLogical = layouts.A_current.logicalBytes;
        if (currentLogical > MAX_REAL_REDIS_LOGICAL_BYTES) {
          realRedis.push({
            requestedActivityBytes: target,
            ...testCase,
            skipped: true,
            reason: `current logical layout ${currentLogical} exceeds safety cap ${MAX_REAL_REDIS_LOGICAL_BYTES}`,
          });
          continue;
        }
        const caseId = `a${target}-r${testCase.recipients}-e${testCase.endpoints}`;
        const variants = [];
        for (const [name, layout] of Object.entries(layouts)) {
          variants.push(await runLayout(client, caseId, name, layout, testCase.endpoints));
        }
        const baseline = variants.find(item => item.variant === "A_current");
        for (const variant of variants) {
          variant.redisReductionVsCurrent = baseline.redisBytes / Math.max(1, variant.redisBytes);
          variant.logicalReductionVsCurrent = baseline.logicalFieldBytes / Math.max(1, variant.logicalFieldBytes);
        }
        realRedis.push({
          requestedActivityBytes: target,
          actualActivityBytes: Buffer.byteLength(activity),
          recipients: testCase.recipients,
          uniqueDeliveryEndpoints: testCase.endpoints,
          targetJsonBytes: Buffer.byteLength(JSON.stringify(targets)),
          variants,
        });
      }
    }

    const output = {
      schema: "apdm-redis-payload-efficiency.v1",
      measuredAt: new Date().toISOString(),
      node: process.version,
      redisUrl: REDIS_URL.replace(/:\/\/.*@/, "://<redacted>@"),
      scope: "evidence-only; no production queue schema changes",
      invariants: [
        "outbound copy count is unique delivery endpoints after shared-inbox collapse, not raw recipient count",
        "reference variants require an independently durable payload-retention and cleanup contract before production use",
        "compression results are cached/reused rather than recompressing identical Activity bytes for every endpoint",
        "real Redis memory uses MEMORY USAGE SAMPLES 0 and includes allocator/data-structure overhead for benchmark keys",
      ],
      codecs,
      theoretical,
      realRedis,
    };

    const rendered = `${JSON.stringify(output, null, 2)}\n`;
    if (OUTPUT_PATH) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const resolved = path.resolve(OUTPUT_PATH);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, rendered, { mode: 0o600 });
    }
    process.stdout.write(rendered);
  } finally {
    await client.quit();
  }
}

await main();
