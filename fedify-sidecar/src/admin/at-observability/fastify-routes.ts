import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ObservedAtIdentityStore } from "../../protocol-bridge/identity/ObservedAtIdentityStore.js";
import { applyLocaleHeaders, resolveLocale, t } from "../../http/locale.js";

export interface AtIdentityObservabilityRouteDeps {
  adminToken: string;
  store: ObservedAtIdentityStore;
}

export function registerAtIdentityObservabilityFastifyRoutes(
  app: FastifyInstance,
  deps: AtIdentityObservabilityRouteDeps,
): void {
  app.get("/internal/admin/at-observability/identities", async (req, reply) => {
    const locale = resolveLocale(req.headers["accept-language"]);
    applyLocaleHeaders(reply, locale);

    if (!isAuthorized(req, deps.adminToken)) {
      reply.code(401).send({ error: "unauthorized", message: t(locale, "common.unauthorized") });
      return;
    }

    if (!hasReadPermission(req)) {
      reply.code(403).send({
        error: "forbidden",
        message: t(locale, "admin.missingReadPermission"),
      });
      return;
    }

    const query = req.query as { limit?: string | number };
    const limit = clampLimit(query.limit);
    const [summary, topUnbound, topBound, recent] = await Promise.all([
      deps.store.getSummary(),
      deps.store.listTopUnbound(limit),
      deps.store.listTopBound(limit),
      deps.store.listRecent(limit),
    ]);

    reply.send({
      generatedAt: new Date().toISOString(),
      summary,
      topUnbound,
      topBound,
      recent,
      queries: {
        projected: 'sum by (reason) (fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="projected"})',
        skipped: 'sum by (reason) (fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="skipped"})',
        failed: 'sum by (reason) (fedify_protocol_bridge_projection_outcomes_total{direction="at_to_ap",outcome="failed"})',
      },
    });
  });
}

function isAuthorized(req: FastifyRequest, token: string): boolean {
  if (!token) {
    return false;
  }

  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }

  return header === `Bearer ${token}`;
}

function hasReadPermission(req: FastifyRequest): boolean {
  const raw = typeof req.headers["x-provider-permissions"] === "string"
    ? req.headers["x-provider-permissions"]
    : "";
  return raw.split(",").map((value) => value.trim()).includes("provider:read");
}

function clampLimit(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "25", 10);
  if (!Number.isFinite(parsed)) {
    return 25;
  }
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}
