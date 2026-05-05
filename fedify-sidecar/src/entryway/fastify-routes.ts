import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { EntrywayError, toEntrywayError } from "./errors.js";
import type { EntrywayProvisioningService } from "./EntrywayProvisioningService.js";
import type { AccountRoute, EntrywayAccountCreateInput } from "./types.js";

export interface EntrywayFastifyRouteDeps {
  service: EntrywayProvisioningService;
  entrywayToken: string;
  allowPublicResolve?: boolean;
}

const createAccountBodySchema = z.object({
  username: z.string().trim().min(3).max(64),
  email: z.string().trim().email().max(320).optional(),
  password: z.string().min(8).max(1024),
  profile: z.object({
    displayName: z.string().trim().min(1).max(128),
    summary: z.string().trim().max(512).optional(),
  }),
  protocols: z.object({
    solid: z.boolean().optional(),
    activitypub: z.boolean().optional(),
    atproto: z.union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        handle: z.string().trim().min(1).max(253).optional(),
        didMethod: z.enum(["did:plc", "did:web"]).optional(),
      }),
    ]).optional(),
  }).optional(),
  providerId: z.string().trim().min(1).max(128).optional(),
  appClientId: z.string().trim().url().max(2048).optional(),
  redirectUri: z.string().trim().url().max(2048).optional(),
  verification: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

const recoverBodySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
}).optional();

export function registerEntrywayFastifyRoutes(app: FastifyInstance, deps: EntrywayFastifyRouteDeps): void {
  app.post("/entryway/accounts", async (req, reply) => {
    applyNoStoreHeaders(reply);
    if (!isAuthorized(req, deps.entrywayToken)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    try {
      const body = parseRequestBody(req.body);
      const parsed = createAccountBodySchema.safeParse(body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request" });
        return;
      }

      const idempotencyKey = readIdempotencyKey(req) ?? parsed.data.idempotencyKey;
      if (!idempotencyKey) {
        reply.code(400).send({ error: "idempotency_key_required", retryable: false });
        return;
      }

      const result = await deps.service.createAccount({
        ...parsed.data,
        idempotencyKey,
      } as EntrywayAccountCreateInput);

      reply.code(result.replayed ? 200 : 201).send({
        account: serializeAccountRoute(result.route),
        replayed: result.replayed,
        sessionHandoff: result.sessionHandoff,
      });
    } catch (error) {
      sendEntrywayError(reply, error);
    }
  });

  app.get("/entryway/accounts/by-username/:username", async (req, reply) => {
    applyNoStoreHeaders(reply);
    if (!deps.allowPublicResolve && !isAuthorized(req, deps.entrywayToken)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const username = String((req.params as Record<string, unknown>)["username"] ?? "");
    if (!username.trim()) {
      reply.code(400).send({ error: "invalid_username" });
      return;
    }

    try {
      const route = await deps.service.getByUsername(username);
      if (!route) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.send({ account: serializeAccountRoute(route) });
    } catch (error) {
      sendEntrywayError(reply, error);
    }
  });

  app.get("/entryway/accounts/:accountId", async (req, reply) => {
    applyNoStoreHeaders(reply);
    if (!isAuthorized(req, deps.entrywayToken)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const accountId = String((req.params as Record<string, unknown>)["accountId"] ?? "");
    if (!/^acct_[0-9a-f-]{36}$/i.test(accountId)) {
      reply.code(400).send({ error: "invalid_account_id" });
      return;
    }

    try {
      const route = await deps.service.getByAccountId(accountId);
      if (!route) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.send({ account: serializeAccountRoute(route) });
    } catch (error) {
      sendEntrywayError(reply, error);
    }
  });

  app.post("/entryway/recover", async (req, reply) => {
    applyNoStoreHeaders(reply);
    if (!isAuthorized(req, deps.entrywayToken)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    try {
      const parsed = recoverBodySchema.safeParse(parseRequestBody(req.body));
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request" });
        return;
      }

      const result = await deps.service.recoverStaleProvisioning(parsed.data?.limit);
      reply.send(result);
    } catch (error) {
      sendEntrywayError(reply, error);
    }
  });
}

function serializeAccountRoute(route: AccountRoute): Record<string, unknown> {
  return {
    accountId: route.accountId,
    canonicalAccountId: route.canonicalAccountId,
    username: route.username,
    handle: route.handle,
    webId: route.webId,
    actorId: route.actorId,
    inbox: route.inbox,
    outbox: route.outbox,
    followers: route.followers,
    following: route.following,
    podStorageUrl: route.podStorageUrl,
    providerId: route.providerId,
    providerBaseUrl: route.providerBaseUrl,
    oidcIssuer: route.oidcIssuer,
    atprotoDid: route.atprotoDid,
    atprotoHandle: route.atprotoHandle,
    appBootstrap: route.appBootstrap,
    status: route.status,
    provisioning: {
      phase: route.provisioning.phase,
      attempts: route.provisioning.attempts,
      checks: route.provisioning.checks,
      lastErrorCode: route.provisioning.lastErrorCode,
      lastErrorMessage: route.provisioning.lastErrorMessage,
      lastAttemptAt: route.provisioning.lastAttemptAt,
      completedAt: route.provisioning.completedAt,
    },
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

function isAuthorized(req: FastifyRequest, token: string): boolean {
  if (!token) {
    return false;
  }

  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }

  const expected = `Bearer ${token}`;
  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  return undefined;
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new EntrywayError("invalid_json", "Request body must be valid JSON", { statusCode: 400 });
  }
}

function sendEntrywayError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown): void {
  const entrywayError = toEntrywayError(error);
  reply.code(entrywayError.statusCode).send({
    error: entrywayError.code,
    message: entrywayError.message,
    retryable: entrywayError.retryable,
  });
}

function applyNoStoreHeaders(reply: {
  header(name: string, value: string): unknown;
}): void {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
}
