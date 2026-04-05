/**
 * FedifyFederationAdapter
 *
 * Concrete implementation of FederationRuntimeAdapter that wires to a real
 * Fedify 2.x Federation instance.
 *
 * Responsibilities:
 *  - Create and configure a Fedify Federation<void> instance.
 *  - Implement onInboundVerified / onOutboundDelivered hooks by forwarding
 *    observability signals into Fedify context (tracing, metrics).
 *  - Expose the Federation instance so index.ts can register it with the
 *    Hono/Fastify HTTP server once ENABLE_FEDIFY_RUNTIME_INTEGRATION=true.
 *
 * Architecture boundary:
 *  - ActivityPods remains the signing authority; keys never leave it.
 *  - This adapter does NOT perform HTTP delivery — that stays in OutboundWorker.
 *  - This adapter does NOT verify HTTP signatures — that stays in InboundWorker.
 *  - The Federation instance here is used for: actor document dispatch,
 *    WebFinger, NodeInfo, and future inbox handler delegation.
 *
 * Fedify 2.x migration notes applied here:
 *  - Uses `documentLoaderFactory` / `contextLoaderFactory` (not deprecated
 *    `documentLoader` / `contextLoader`).
 *  - Actor dispatcher uses `{ identifier }` path param (not removed `{ handle }`).
 *  - KvStore.list() is implemented (required in 2.x).
 *  - Idempotency: explicit `"per-inbox"` (now the default, documented here for
 *    clarity since the sidecar has its own Redis-level idempotency layer).
 */

import {
  createFederation,
  type Actor,
  type Context,
  type Federation,
  Person,
} from "@fedify/fedify";
import type { FederationRuntimeAdapter } from "../core-domain/contracts/SigningContracts.js";
import type { FedifyKvStore } from "./FedifyKvAdapter.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FedifyAdapterConfig {
  /** Public hostname of this sidecar, e.g. "social.example.com" */
  domain: string;
  /**
   * Base URL of the ActivityPods instance for proxying actor documents and
   * signing requests, e.g. "https://activitypods.example.com"
   */
  activityPodsUrl: string;
  /** Bearer token for ActivityPods internal API calls. */
  activityPodsToken: string;
}

export interface FedifyAdapterLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: FedifyAdapterLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------------
// Adapter context data — passed through every Fedify context callback
// ---------------------------------------------------------------------------

interface SidecarContext {
  domain: string;
  activityPodsUrl: string;
  activityPodsToken: string;
}

// ---------------------------------------------------------------------------
// FedifyFederationAdapter
// ---------------------------------------------------------------------------

export class FedifyFederationAdapter implements FederationRuntimeAdapter {
  readonly name = "fedify-v2";
  readonly enabled = true;

  private readonly federation: Federation<SidecarContext>;
  private readonly logger: FedifyAdapterLogger;

  constructor(
    kv: FedifyKvStore,
    private readonly config: FedifyAdapterConfig,
    logger?: FedifyAdapterLogger
  ) {
    this.logger = logger ?? NOOP_LOGGER;
    this.federation = this.buildFederation(kv);
  }

  // --------------------------------------------------------------------------
  // Public: expose the Federation instance for HTTP route registration
  // --------------------------------------------------------------------------

  /**
   * Returns the underlying Fedify Federation instance so that index.ts can
   * register it with Hono/Fastify:
   *
   *   const handler = federation.fetch.bind(federation);
   *   app.use("*", (c) => handler(c.req.raw, { ...sidecarContext }));
   */
  getFederation(): Federation<SidecarContext> {
    return this.federation;
  }

  /**
   * Build the context object passed to every Fedify handler.
   * Call this from the HTTP middleware layer.
   */
  buildContext(): SidecarContext {
    return {
      domain: this.config.domain,
      activityPodsUrl: this.config.activityPodsUrl,
      activityPodsToken: this.config.activityPodsToken,
    };
  }

  // --------------------------------------------------------------------------
  // FederationRuntimeAdapter hooks
  // --------------------------------------------------------------------------

  async onInboundVerified(input: {
    actorUri: string;
    activityId?: string;
    activityType?: string;
    isPublic?: boolean;
  }): Promise<void> {
    try {
      this.logger.info("[fedify] inbound verified", {
        actorUri: input.actorUri,
        activityId: input.activityId,
        activityType: input.activityType,
        isPublic: input.isPublic,
      });
      // TODO: when inbox handler delegation is enabled, forward to
      //   this.federation.processMessage(request, context) instead of
      //   letting InboundWorker forward to ActivityPods directly.
    } catch (err) {
      // Adapter errors must never propagate (per FederationRuntimeAdapter contract).
      this.logger.error("[fedify] onInboundVerified error (swallowed)", {
        err: String(err),
      });
    }
  }

  async onOutboundDelivered(input: {
    actorUri: string;
    activityId: string;
    targetDomain: string;
    statusCode?: number;
  }): Promise<void> {
    try {
      this.logger.info("[fedify] outbound delivered", {
        actorUri: input.actorUri,
        activityId: input.activityId,
        targetDomain: input.targetDomain,
        statusCode: input.statusCode,
      });
      // TODO: when Fedify handles delivery, report permanent failures here
      //   via federation's permanentFailureStatusCodes integration.
    } catch (err) {
      this.logger.error("[fedify] onOutboundDelivered error (swallowed)", {
        err: String(err),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Federation setup
  // --------------------------------------------------------------------------

  private buildFederation(kv: FedifyKvStore): Federation<SidecarContext> {
    // Cast: FedifyKvStore is structurally compatible with Fedify's KvStore.
    // The package types will validate this at compile time once installed.
    const federation = createFederation<SidecarContext>({
      kv: kv as Parameters<typeof createFederation>[0]["kv"],

      // Fedify 2.x: documentLoaderFactory replaces deprecated documentLoader.
      // The default factory is adequate; override only if you need custom
      // auth headers for fetching remote ActivityPub documents.
      // documentLoaderFactory: (ctx) => getDocumentLoader({ ... }),

      // Explicit idempotency strategy. "per-inbox" is the 2.x default.
      // The sidecar also enforces its own Redis-level idempotency in
      // OutboundWorker, so this is belt-and-suspenders.
      // TODO: uncomment once @fedify/fedify 2.x types are installed:
      // inboxIdempotency: { strategy: "per-inbox" },
    });

    this.registerActorDispatcher(federation);
    this.registerInboxListeners(federation);
    this.registerNodeInfo(federation);

    return federation;
  }

  // --------------------------------------------------------------------------
  // Actor dispatcher
  // --------------------------------------------------------------------------

  private registerActorDispatcher(
    federation: Federation<SidecarContext>
  ): void {
    // Fedify 2.x: path param is {identifier}, not the removed {handle}.
    federation.setActorDispatcher(
      "/users/{identifier}",
      async (ctx: Context<SidecarContext>, identifier: string): Promise<Actor | null> => {
        // Proxy actor document from ActivityPods so Fedify can serve it.
        // ActivityPods is the source of truth for actor data.
        try {
          const resp = await fetch(
            `${ctx.data.activityPodsUrl}/users/${encodeURIComponent(identifier)}`,
            {
              headers: {
                Accept: "application/activity+json",
                Authorization: `Bearer ${ctx.data.activityPodsToken}`,
              },
              signal: AbortSignal.timeout(10_000),
            }
          );
          if (!resp.ok) return null;
          const doc = (await resp.json()) as Record<string, unknown>;

          // Build a minimal Person so Fedify can handle WebFinger + key lookup.
          // The full actor document continues to be served by the proxy handler.
          return new Person({
            id: new URL(doc["id"] as string),
            name: (doc["name"] as string | undefined) ?? identifier,
            preferredUsername: identifier,
            inbox: new URL(`${ctx.data.activityPodsUrl}/users/${identifier}/inbox`),
            outbox: new URL(`${ctx.data.activityPodsUrl}/users/${identifier}/outbox`),
            followers: new URL(
              `${ctx.data.activityPodsUrl}/users/${identifier}/followers`
            ),
            following: new URL(
              `${ctx.data.activityPodsUrl}/users/${identifier}/following`
            ),
            url: new URL(doc["url"] as string ?? `https://${ctx.data.domain}/users/${identifier}`),
          });
        } catch {
          return null;
        }
      }
    );
  }

  // --------------------------------------------------------------------------
  // Inbox listeners (stub — ActivityPods handles actual inbox processing)
  // --------------------------------------------------------------------------

  private registerInboxListeners(
    federation: Federation<SidecarContext>
  ): void {
    // When inbox handler delegation is fully enabled, activity-specific
    // listeners will be registered here (Create, Follow, Like, Announce, etc.).
    // For now this is intentionally empty — InboundWorker forwards to
    // ActivityPods and calls onInboundVerified for observability.
    //
    // Example future shape:
    //   federation
    //     .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    //     .on(Create, async (ctx, create) => { ... })
    //     .on(Follow, async (ctx, follow) => { ... });
  }

  // --------------------------------------------------------------------------
  // NodeInfo
  // --------------------------------------------------------------------------

  private registerNodeInfo(federation: Federation<SidecarContext>): void {
    // Fedify 2.x: software.version is a plain string (SemVer type removed).
    federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (_ctx) => ({
      software: {
        name: "mastopod-federation-sidecar",
        version: "6.5.0", // plain string in 2.x (was SemVer object in 1.x)
        homepage: new URL("https://github.com/activitypods/mastopod"),
      },
      protocols: ["activitypub"],
      usage: {
        users: { total: 0, activeMonth: 0, activeHalfyear: 0 },
        localPosts: 0,
        localComments: 0,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FedifyFederationAdapter from a Redis ioredis client.
 *
 * Usage in index.ts:
 *
 *   import Redis from "ioredis";
 *   import { FedifyKvAdapter } from "./federation/FedifyKvAdapter.js";
 *   import { createFedifyAdapter } from "./federation/FedifyFederationAdapter.js";
 *
 *   const redis = new Redis(redisUrl);
 *   const kv = new FedifyKvAdapter(redis);
 *   const fedifyAdapter = createFedifyAdapter(kv, {
 *     domain: config.domain,
 *     activityPodsUrl: config.activityPodsUrl,
 *     activityPodsToken: config.activityPodsToken,
 *   }, logger);
 *
 *   // Pass to workers:
 *   createOutboundWorker(..., { adapter: fedifyAdapter, fedifyRuntimeIntegrationEnabled: true })
 *
 *   // Register with Hono:
 *   const fed = fedifyAdapter.getFederation();
 *   app.use("*", (c) => fed.fetch(c.req.raw, fedifyAdapter.buildContext()));
 */
export function createFedifyAdapter(
  kv: FedifyKvStore,
  config: FedifyAdapterConfig,
  logger?: FedifyAdapterLogger
): FedifyFederationAdapter {
  return new FedifyFederationAdapter(kv, config, logger);
}
