import { Redis } from "ioredis";
import { ulid } from "ulid";
import type { Logger } from "pino";
import { ensureDefaultModuleConfigs } from "./bootstrap.js";
import { LoggerMRFAuditSink } from "./audit-sinks.js";
import { registerMRFAdminFastifyRoutes } from "./fastify-routes.js";
import { runSimulationJob } from "./simulator.js";
import { InMemoryMRFAdminStore } from "./store.memory.js";
import { RedisMRFAdminStore } from "./store.redis.js";
import { forbidden } from "./errors.js";
import { withRetry } from "./utils.js";
import type { MRFAdminDeps, MRFPermission } from "./types.js";
import type { MRFAdminStore } from "./store.js";

interface RegisterOptions {
  app: any;
  logger: Logger;
  enabled: boolean;
  adminToken: string;
  storeMode: "memory" | "redis";
  redisUrl: string;
  redisPrefix: string;
}

function parsePermissions(req: Request): Set<string> {
  const raw = (req.headers.get("x-provider-permissions") || "").slice(0, 1024);
  const allowed = new Set<MRFPermission>(["provider:read", "provider:write", "provider:simulate"]);
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is MRFPermission => allowed.has(value as MRFPermission)),
  );
}

function sanitizeActor(value: string | null): string {
  const fallback = "gateway:unknown";
  if (!value) return fallback;
  const trimmed = value.trim().slice(0, 128);
  if (!/^[a-zA-Z0-9:_./@-]+$/.test(trimmed)) return fallback;
  return trimmed;
}

export async function registerMrfAdminIntegration(options: RegisterOptions): Promise<{
  redisClient: Redis | null;
  store: MRFAdminStore;
}> {
  if (!options.enabled) {
    throw new Error("MRF admin integration requested while disabled");
  }

  if (!options.adminToken) {
    throw new Error("ENABLE_MRF_ADMIN_API=true requires MRF_ADMIN_TOKEN");
  }

  const now = () => new Date().toISOString();
  const redisClient = options.storeMode === "redis"
    ? new Redis(options.redisUrl)
    : null;

  if (redisClient) {
    redisClient.on("error", (err: Error) => {
      options.logger.error({ error: err.message }, "MRF admin Redis client error");
    });
  }

  const store = redisClient
    ? new RedisMRFAdminStore(redisClient, { prefix: options.redisPrefix, now })
    : new InMemoryMRFAdminStore(now);

  await withRetry(
    async () => ensureDefaultModuleConfigs(store, now),
    { retries: 4, baseMs: 100, maxMs: 2000 },
  );

  const deps = {} as MRFAdminDeps;
  Object.assign(deps, {
    adminToken: options.adminToken,
    store,
    audit: new LoggerMRFAuditSink(options.logger),
    now,
    uuid: () => ulid(),
    actorFromRequest: (req: Request) => sanitizeActor(req.headers.get("x-provider-actor")),
    sourceIpFromRequest: (req: Request) => {
      const forwarded = req.headers.get("x-forwarded-for") || "";
      const first = forwarded.split(",")[0]?.trim();
      return first || undefined;
    },
    authorize: (req: Request, permission: MRFPermission) => {
      const permissions = parsePermissions(req);
      if (!permissions.has(permission)) {
        throw forbidden(`Missing required permission: ${permission}`);
      }
    },
    enqueueSimulation: async (jobId: string) => {
      setTimeout(() => {
        runSimulationJob(jobId, deps).catch((err) => {
          options.logger.error({ error: err instanceof Error ? err.message : String(err), jobId }, "MRF simulation worker error");
        });
      }, 0);
    },
  });

  registerMRFAdminFastifyRoutes(options.app, deps);

  options.logger.info(
    {
      storeMode: options.storeMode,
      redisPrefix: options.redisPrefix,
    },
    "MRF admin routes registered",
  );

  return { redisClient, store };
}
