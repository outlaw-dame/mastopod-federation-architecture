import { Redis } from "ioredis";
import { ulid } from "ulid";
import type { Logger } from "pino";
import type { IdentityBindingRepository } from "../../core-domain/identity/IdentityBindingRepository.js";
import { forbidden } from "../mrf/errors.js";
import type { MRFPermission } from "../mrf/types.js";
import { registerModerationBridgeFastifyRoutes } from "./fastify-routes.js";
import { ActivityPodsModerationCaseStore, CompositeModerationBridgeStore } from "./activitypods-case-store.js";
import { createAtLabelEmitter } from "./label-emitter.js";
import { InMemoryModerationBridgeStore } from "./store.memory.js";
import { RedisModerationBridgeStore } from "./store.redis.js";
import type { ModerationBridgeDeps, ModerationBridgeStore } from "./types.js";
import type { CanonicalIntentPublisher } from "../../protocol-bridge/canonical/CanonicalIntentPublisher.js";

interface RegisterOptions {
  app: any;
  logger: Logger;
  enabled: boolean;
  adminToken: string;
  storeMode: "memory" | "redis";
  redisUrl: string;
  redisPrefix: string;
  identityBindingRepository: IdentityBindingRepository;
  labelerDid: string;
  labelerSigningKeyHex?: string;
  atAdminXrpcBaseUrl?: string;
  atAdminBearerToken?: string;
  atAdminTimeoutMs?: number;
  activityPodsBaseUrl?: string;
  activityPodsBearerToken?: string;
  activityPodsTimeoutMs?: number;
  activityPodsRetries?: number;
  activityPodsRetryBaseMs?: number;
  activityPodsRetryMaxMs?: number;
  internalBridgeToken?: string;
  canonicalPublisher?: CanonicalIntentPublisher;
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

function sanitizeActor(raw: string | null): string {
  if (!raw) return "provider:unknown";
  const trimmed = raw.trim();
  if (!trimmed) return "provider:unknown";
  return trimmed.slice(0, 256);
}

export async function registerModerationBridgeIntegration(options: RegisterOptions): Promise<{
  redisClient: Redis | null;
  store: ModerationBridgeStore;
}> {
  if (!options.enabled) {
    options.logger.info("Moderation bridge integration disabled");
    return { redisClient: null, store: new InMemoryModerationBridgeStore() };
  }

  if (!options.adminToken) {
    options.logger.warn("Moderation bridge admin token is empty; routes will reject with 401");
  }

  const now = () => new Date().toISOString();
  const redisClient = options.storeMode === "redis"
    ? new Redis(options.redisUrl)
    : null;

  if (redisClient) {
    redisClient.on("error", (err: Error) => {
      options.logger.error({ error: err.message }, "Moderation bridge Redis client error");
    });
  }

  const store = redisClient
    ? new RedisModerationBridgeStore(redisClient, { prefix: options.redisPrefix, now })
    : new InMemoryModerationBridgeStore();
  const remoteCaseStore =
    options.activityPodsBaseUrl && options.activityPodsBearerToken
      ? new ActivityPodsModerationCaseStore({
          baseUrl: options.activityPodsBaseUrl,
          bearerToken: options.activityPodsBearerToken,
          timeoutMs: options.activityPodsTimeoutMs,
          retries: options.activityPodsRetries,
          retryBaseMs: options.activityPodsRetryBaseMs,
          retryMaxMs: options.activityPodsRetryMaxMs,
        })
      : null;
  const compositeStore = remoteCaseStore
    ? new CompositeModerationBridgeStore(store, remoteCaseStore)
    : store;

  const labelEmitter = createAtLabelEmitter(store, {
    labelerDid: options.labelerDid,
    signingKeyHex: options.labelerSigningKeyHex,
    now,
  });

  const deps = {} as ModerationBridgeDeps;
  Object.assign(deps, {
    adminToken: options.adminToken,
    store: compositeStore,
    labelEmitter,
    now,
    uuid: () => ulid(),
    actorFromRequest: (req: Request) => sanitizeActor(req.headers.get("x-provider-actor")),
    authorize: (req: Request, permission: MRFPermission) => {
      const permissions = parsePermissions(req);
      if (!permissions.has(permission)) {
        throw forbidden(`Missing required permission: ${permission}`);
      }
    },
    resolveAtDid: async (webId: string): Promise<string | null> => {
      const binding = await options.identityBindingRepository.getByWebId(webId);
      return binding?.atprotoDid ?? null;
    },
    resolveWebId: async (atDid: string): Promise<string | null> => {
      const binding = await options.identityBindingRepository.getByAtprotoDid(atDid);
      return binding?.webId ?? null;
    },
    resolveActivityPubActorUri: async (webId: string): Promise<string | null> => {
      const binding = await options.identityBindingRepository.getByWebId(webId);
      return binding?.activityPubActorUri ?? null;
    },
    resolveWebIdForActorUri: async (actorUri: string): Promise<string | null> => {
      const binding = await options.identityBindingRepository.getByActivityPubActorUri(actorUri);
      return binding?.webId ?? null;
    },
    mrfInternalFetch: async ({
      method,
      path,
      body,
      permission,
      actorWebId,
    }: {
      method: string;
      path: string;
      body?: unknown;
      permission: MRFPermission;
      actorWebId?: string;
    }) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.adminToken}`,
        "content-type": "application/json",
        "x-provider-permissions": permission,
      };
      if (actorWebId) headers["x-provider-actor"] = actorWebId;

      const payload = body === undefined ? undefined : JSON.stringify(body);
      const res = await options.app.inject({
        method,
        url: path,
        headers,
        payload,
      });

      const headerPairs: Array<[string, string]> = [];
      for (const [key, value] of Object.entries(res.headers)) {
        headerPairs.push([key, String(value)]);
      }

      return new Response(res.body || "", {
        status: res.statusCode,
        headers: new Headers(headerPairs),
      });
    },
    updateAtSubjectStatus: options.atAdminXrpcBaseUrl && options.atAdminBearerToken
      ? async ({ did, reason }: { did: string; reason?: string }): Promise<boolean> => {
          const endpoint = `${options.atAdminXrpcBaseUrl!.replace(/\/$/, "")}/xrpc/com.atproto.admin.updateSubjectStatus`;
          const timeoutMs = options.atAdminTimeoutMs ?? 5_000;

          const payload = {
            subject: {
              $type: "com.atproto.admin.defs#repoRef",
              did,
            },
            deactivated: { applied: true },
            takedown: {
              applied: true,
              ref: reason?.slice(0, 256),
            },
          };

          try {
            const response = await fetch(endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${options.atAdminBearerToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(timeoutMs),
            });

            if (!response.ok) {
              options.logger.warn(
                {
                  status: response.status,
                  did,
                },
                "AT admin updateSubjectStatus call failed",
              );
              return false;
            }

            return true;
          } catch (error) {
            options.logger.warn(
              {
                did,
                error: error instanceof Error ? error.message : String(error),
              },
              "AT admin updateSubjectStatus call errored",
            );
            return false;
          }
        }
      : undefined,
  });

  registerModerationBridgeFastifyRoutes(options.app, deps, {
    internalBridgeToken: options.internalBridgeToken,
    canonicalPublisher: options.canonicalPublisher,
    now,
  });

  options.logger.info(
    {
      storeMode: options.storeMode,
      redisPrefix: options.redisPrefix,
      labelerDid: options.labelerDid,
    },
    "Moderation bridge routes registered",
  );

  return { redisClient, store: compositeStore };
}
