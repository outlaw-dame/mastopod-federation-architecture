import { z } from "zod";

export const moduleModeSchema = z.enum(["disabled", "dry-run", "enforce"]);
export const traceVerbositySchema = z.enum(["minimal", "standard", "verbose"]);

export const patchModuleSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: moduleModeSchema.optional(),
    priority: z.number().int().min(0).max(10000).optional(),
    stopOnMatch: z.boolean().optional(),
    config: z.record(z.unknown()).optional(),
    expectedRevision: z.number().int().min(0).optional(),
  })
  .strict();

export const patchChainSchema = z
  .object({
    stopOnReject: z.boolean().optional(),
    defaultTraceVerbosity: traceVerbositySchema.optional(),
    modules: z
      .array(
        z
          .object({
            id: z.string().min(1),
            priority: z.number().int().min(0).max(10000),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .optional(),
    expectedRevision: z.number().int().min(0).optional(),
  })
  .strict();

export const listTracesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  moduleId: z.string().optional(),
  action: z.enum(["accept", "label", "downrank", "filter", "reject"]).optional(),
  originHost: z.string().optional(),
  activityId: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  includePrivate: z.coerce.boolean().default(false),
});

export const simulateSchema = z
  .object({
    activityId: z.string().url().optional(),
    payload: z
      .object({
        id: z.string().min(1),
        actor: z.string().min(1),
        content: z.string().optional(),
        visibility: z.enum(["public", "unlisted", "followers", "direct"]).optional(),
        tags: z.array(z.string()).optional(),
        language: z.string().optional(),
        published: z.string().optional(),
      })
      .optional(),
    modules: z.array(z.string()).max(50).optional(),
    modeOverride: moduleModeSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.activityId && !val.payload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either activityId or payload is required",
      });
    }
  });
