import type { FastifyInstance } from "fastify";
import type { DomainReputationStore } from "../../delivery/DomainReputationStore.js";
import { sanitizeDomain } from "../../delivery/DomainReputationStore.js";

function verifyToken(req: { headers: Record<string, string | string[] | undefined> }, adminToken: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;
  const parts = auth.split(" ");
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer" && parts[1] === adminToken;
}

function unauthorized(reply: any): void {
  reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Valid admin token required" } });
}

function badRequest(reply: any, message: string): void {
  reply.code(400).send({ error: { code: "BAD_REQUEST", message } });
}

export function registerSpamDomainAdminRoutes(
  app: FastifyInstance,
  domainStore: DomainReputationStore,
  adminToken: string,
): void {
  // GET /internal/admin/spam/domains — list all blocked domains
  app.get("/internal/admin/spam/domains", async (req, reply) => {
    if (!verifyToken(req, adminToken)) return unauthorized(reply);
    try {
      const domains = await domainStore.listDomains();
      reply.send({ domains });
    } catch (err) {
      reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to list domains" } });
    }
  });

  // POST /internal/admin/spam/domains — add a domain
  app.post("/internal/admin/spam/domains", async (req, reply) => {
    if (!verifyToken(req, adminToken)) return unauthorized(reply);

    const body = req.body as Record<string, unknown>;
    const rawDomain = body?.["domain"];
    const subdomainMatch = body?.["subdomainMatch"] === true;

    if (typeof rawDomain !== "string" || !rawDomain.trim()) {
      return badRequest(reply, "domain is required");
    }

    const domain = sanitizeDomain(rawDomain);
    if (!domain) {
      return badRequest(reply, `Invalid domain: "${rawDomain}". Must be a valid hostname (no IPs, no ports).`);
    }

    try {
      await domainStore.addDomain(domain, subdomainMatch);
      reply.code(201).send({ domain, subdomainMatch });
    } catch (err) {
      reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to add domain" } });
    }
  });

  // DELETE /internal/admin/spam/domains — remove a domain
  app.delete("/internal/admin/spam/domains", async (req, reply) => {
    if (!verifyToken(req, adminToken)) return unauthorized(reply);

    const body = req.body as Record<string, unknown>;
    const rawDomain = body?.["domain"];
    const subdomainMatch = body?.["subdomainMatch"] === true;

    if (typeof rawDomain !== "string" || !rawDomain.trim()) {
      return badRequest(reply, "domain is required");
    }

    const domain = sanitizeDomain(rawDomain);
    if (!domain) {
      return badRequest(reply, `Invalid domain: "${rawDomain}"`);
    }

    try {
      await domainStore.removeDomain(domain, subdomainMatch);
      reply.code(200).send({ domain, subdomainMatch, removed: true });
    } catch (err) {
      reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to remove domain" } });
    }
  });
}
