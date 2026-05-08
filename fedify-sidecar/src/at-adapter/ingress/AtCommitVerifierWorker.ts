/**
 * Worker thread entrypoint for the AT commit verifier pool.
 *
 * Each worker constructs its own ProductionAtCommitVerifier with an
 * independent ioredis client (cache layer is shared via Redis, not via
 * process memory). The parent thread dispatches verifyCommit() calls over
 * parentPort and receives results back.
 *
 * This file is loaded with `--import tsx` from AtCommitVerifierWorkerPool.
 */

import { parentPort, workerData } from "node:worker_threads";
import { Agent, setGlobalDispatcher } from "undici";
import { Redis } from "ioredis";
import { HttpAtIdentityResolver, type HttpAtIdentityResolverOptions } from "./HttpAtIdentityResolver.js";
import { RedisAtprotoRepoRegistry } from "../../atproto/repo/AtprotoRepoRegistry.js";
import {
  ProductionAtCommitVerifier,
  type ProductionAtCommitVerifierOptions,
} from "./ProductionAtCommitVerifier.js";

// Configure undici's global dispatcher with a much larger per-origin connection
// pool. Default `connections: undefined` maps to a small pool (~6/origin) with
// pipelining=1, which causes huge HoL queueing when this worker concurrently
// resolves dozens of unique DID documents from plc.directory. The bottleneck
// analysis (avg 1.5s/verify, p99 30s+) is dominated by HTTP queuing, not crypto.
const POOL_CONNECTIONS = clampInt(parseInt(process.env["AT_HTTP_POOL_CONNECTIONS"] ?? "", 10), 8, 256, 64);
const POOL_PIPELINING = clampInt(parseInt(process.env["AT_HTTP_POOL_PIPELINING"] ?? "", 10), 1, 16, 4);
const HTTP_HEADERS_TIMEOUT_MS = clampInt(parseInt(process.env["AT_HTTP_HEADERS_TIMEOUT_MS"] ?? "", 10), 500, 30_000, 4_000);
const HTTP_BODY_TIMEOUT_MS = clampInt(parseInt(process.env["AT_HTTP_BODY_TIMEOUT_MS"] ?? "", 10), 500, 30_000, 4_000);
const HTTP_CONNECT_TIMEOUT_MS = clampInt(parseInt(process.env["AT_HTTP_CONNECT_TIMEOUT_MS"] ?? "", 10), 500, 30_000, 3_000);

setGlobalDispatcher(
  new Agent({
    connections: POOL_CONNECTIONS,
    pipelining: POOL_PIPELINING,
    headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
    bodyTimeout: HTTP_BODY_TIMEOUT_MS,
    connect: { timeout: HTTP_CONNECT_TIMEOUT_MS },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  }),
);

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

interface WorkerBootData {
  redisUrl: string;
  identityResolverOptions: Omit<HttpAtIdentityResolverOptions, "redisCache" | "fetchImpl" | "resolveTxtImpl">;
  didDocCacheTtlSeconds: number;
  verifierOptions: Omit<ProductionAtCommitVerifierOptions, "identityResolver" | "repoRegistry">;
}

interface VerifyRequest {
  kind: "verify";
  id: number;
  body: unknown;
}

type WorkerRequest = VerifyRequest;

if (!parentPort) {
  throw new Error("AtCommitVerifierWorker must run as a worker thread");
}

const data = workerData as WorkerBootData;

const redis = new Redis(data.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (err) => {
  // Surface Redis errors but don't crash the worker — verifier calls will
  // fail with a normal verification failure if Redis is unreachable.
  console.error("[AtCommitVerifierWorker] redis error:", err?.message ?? err);
});

const identityResolver = new HttpAtIdentityResolver({
  fetchImpl: fetch,
  ...data.identityResolverOptions,
  redisCache: redis,
  redisCacheTtlSeconds: data.didDocCacheTtlSeconds,
});

const repoRegistry = new RedisAtprotoRepoRegistry(redis);

const verifier = new ProductionAtCommitVerifier({
  ...data.verifierOptions,
  identityResolver,
  repoRegistry,
});

parentPort.postMessage({ kind: "ready" });

parentPort.on("message", async (message: WorkerRequest) => {
  if (message?.kind !== "verify") return;
  const { id, body } = message;
  try {
    const result = await verifier.verifyCommit(body as any);
    parentPort!.postMessage({ kind: "verify-result", id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({
      kind: "verify-result",
      id,
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
