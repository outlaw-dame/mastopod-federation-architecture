import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { MRFAdminStore } from "../mrf/store.js";
import type { MRFModuleConfig } from "../mrf/types.js";
import type { KeywordFilterConfig, KeywordRule } from "../mrf/registry/modules/keyword-filter.js";

// ---------------------------------------------------------------------------
// Shared validation schema — mirrors KeywordRule Zod schema in the registry.
// Kept here so routes validate independently without importing the full registry.
// ---------------------------------------------------------------------------

const keywordRuleBodySchema = z.object({
  pattern: z.string().min(1, "pattern must not be empty").max(500, "pattern exceeds 500 chars"),
  semantic: z.boolean().default(false),
  similarityThreshold: z.number().min(0).max(1).default(0.75),
  wholeWord: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function verifyToken(req: { headers: Record<string, string | string[] | undefined> }, adminToken: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;
  const [scheme, token] = auth.split(" ");
  return scheme?.toLowerCase() === "bearer" && token === adminToken;
}

// ---------------------------------------------------------------------------
// Response helpers — consistent error shape across all routes
// ---------------------------------------------------------------------------

type FastifyReply = { code: (n: number) => FastifyReply; send: (body: unknown) => FastifyReply };

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Valid admin token required" } });
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { code: "BAD_REQUEST", message } });
}

function notFound(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(404).send({ error: { code: "NOT_FOUND", message } });
}

function conflict(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(409).send({ error: { code: "CONFLICT", message } });
}

function internalError(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message } });
}

// ---------------------------------------------------------------------------
// Config helpers — atomic read-modify-write with revision tracking
// ---------------------------------------------------------------------------

async function readConfig(
  store: MRFAdminStore,
): Promise<{ moduleConfig: MRFModuleConfig; rules: KeywordRule[] } | null> {
  const moduleConfig = await store.getModuleConfig("keyword-filter");
  if (!moduleConfig) return null;
  const raw = moduleConfig.config as { rules?: unknown };
  const rules: KeywordRule[] = Array.isArray(raw.rules)
    ? (raw.rules as KeywordRule[])
    : [];
  return { moduleConfig, rules };
}

async function writeRules(
  store: MRFAdminStore,
  moduleConfig: MRFModuleConfig,
  rules: KeywordRule[],
): Promise<void> {
  await store.setModuleConfig("keyword-filter", {
    ...moduleConfig,
    config: { ...moduleConfig.config, rules },
    updatedAt: new Date().toISOString(),
    updatedBy: "keyword-rules-api",
    revision: moduleConfig.revision + 1,
  });
}

// ---------------------------------------------------------------------------
// Regex compile check — literal rules must be compilable before saving
// ---------------------------------------------------------------------------

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function validateLiteralPattern(rule: KeywordRule): string | null {
  if (rule.semantic) return null; // No regex for semantic rules.
  const escaped = rule.pattern.replace(ESCAPE_RE, "\\$&");
  const body = rule.wholeWord ? `\\b${escaped}\\b` : escaped;
  try {
    void new RegExp(body, rule.caseSensitive ? "" : "i");
    return null;
  } catch {
    return `Pattern "${rule.pattern}" produces an invalid regular expression`;
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerKeywordRulesAdminRoutes(
  app: FastifyInstance,
  store: MRFAdminStore,
  adminToken: string,
): void {
  // GET /internal/admin/spam/keyword-rules
  // Returns the ordered rule list and the module's enabled/mode state.
  app.get("/internal/admin/spam/keyword-rules", async (req, reply) => {
    if (!verifyToken(req, adminToken)) return unauthorized(reply as FastifyReply);
    try {
      const state = await readConfig(store);
      if (!state) return internalError(reply as FastifyReply, "keyword-filter module not initialized");
      return reply.send({
        rules: state.rules,
        total: state.rules.length,
        enabled: state.moduleConfig.enabled,
        mode: state.moduleConfig.mode,
      });
    } catch {
      return internalError(reply as FastifyReply, "Failed to read keyword rules");
    }
  });

  // POST /internal/admin/spam/keyword-rules
  // Appends a new rule. Returns 409 if a rule with the same pattern already exists.
  app.post("/internal/admin/spam/keyword-rules", async (req, reply) => {
    if (!verifyToken(req, adminToken)) return unauthorized(reply as FastifyReply);

    let parsed: z.infer<typeof keywordRuleBodySchema>;
    try {
      parsed = keywordRuleBodySchema.parse(req.body);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.errors.map((e) => e.message).join("; ") : "Invalid request body";
      return badRequest(reply as FastifyReply, msg);
    }

    const regexError = validateLiteralPattern(parsed as KeywordRule);
    if (regexError) return badRequest(reply as FastifyReply, regexError);

    try {
      const state = await readConfig(store);
      if (!state) return internalError(reply as FastifyReply, "keyword-filter module not initialized");

      if (state.rules.some((r) => r.pattern === parsed.pattern)) {
        return conflict(reply as FastifyReply, `A rule with pattern "${parsed.pattern}" already exists`);
      }

      const newRule: KeywordRule = {
        pattern: parsed.pattern,
        semantic: parsed.semantic,
        similarityThreshold: parsed.similarityThreshold,
        wholeWord: parsed.wholeWord,
        caseSensitive: parsed.caseSensitive,
      };

      const updated = [...state.rules, newRule];
      await writeRules(store, state.moduleConfig, updated);
      return reply.code(201).send({ rule: newRule, totalRules: updated.length });
    } catch {
      return internalError(reply as FastifyReply, "Failed to add keyword rule");
    }
  });

  // PUT /internal/admin/spam/keyword-rules
  // Updates an existing rule identified by `pattern`. Returns 404 if not found.
  // Sends the full updated rule in the body (pattern is the identifier; all other
  // fields are replaced).
  app.put("/internal/admin/spam/keyword-rules", async (req, reply) => {
    if (!verifyToken(req, adminToken)) return unauthorized(reply as FastifyReply);

    let parsed: z.infer<typeof keywordRuleBodySchema>;
    try {
      parsed = keywordRuleBodySchema.parse(req.body);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.errors.map((e) => e.message).join("; ") : "Invalid request body";
      return badRequest(reply as FastifyReply, msg);
    }

    const regexError = validateLiteralPattern(parsed as KeywordRule);
    if (regexError) return badRequest(reply as FastifyReply, regexError);

    try {
      const state = await readConfig(store);
      if (!state) return internalError(reply as FastifyReply, "keyword-filter module not initialized");

      const idx = state.rules.findIndex((r) => r.pattern === parsed.pattern);
      if (idx === -1) {
        return notFound(reply as FastifyReply, `No rule with pattern "${parsed.pattern}" found`);
      }

      const updatedRule: KeywordRule = {
        pattern: parsed.pattern,
        semantic: parsed.semantic,
        similarityThreshold: parsed.similarityThreshold,
        wholeWord: parsed.wholeWord,
        caseSensitive: parsed.caseSensitive,
      };

      const updatedRules = [...state.rules];
      updatedRules[idx] = updatedRule;
      await writeRules(store, state.moduleConfig, updatedRules);
      return reply.send({ rule: updatedRule, totalRules: updatedRules.length });
    } catch {
      return internalError(reply as FastifyReply, "Failed to update keyword rule");
    }
  });

  // DELETE /internal/admin/spam/keyword-rules
  // Removes the rule with the given pattern. Returns 404 if not found.
  app.delete("/internal/admin/spam/keyword-rules", async (req, reply) => {
    if (!verifyToken(req, adminToken)) return unauthorized(reply as FastifyReply);

    const body = req.body as Record<string, unknown>;
    const rawPattern = body?.["pattern"];
    if (typeof rawPattern !== "string" || !rawPattern.trim()) {
      return badRequest(reply as FastifyReply, "pattern is required");
    }
    const pattern = rawPattern.trim();

    try {
      const state = await readConfig(store);
      if (!state) return internalError(reply as FastifyReply, "keyword-filter module not initialized");

      const idx = state.rules.findIndex((r) => r.pattern === pattern);
      if (idx === -1) {
        return notFound(reply as FastifyReply, `No rule with pattern "${pattern}" found`);
      }

      const updatedRules = state.rules.filter((_, i) => i !== idx);
      await writeRules(store, state.moduleConfig, updatedRules);
      return reply.send({ pattern, removed: true, totalRules: updatedRules.length });
    } catch {
      return internalError(reply as FastifyReply, "Failed to remove keyword rule");
    }
  });
}
