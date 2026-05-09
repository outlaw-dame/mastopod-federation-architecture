import { z } from "zod";

export const ACTIVITYPODS_STORY_COLLECTION = "org.activitypods.story.slide";

export const ACTIVITYPODS_STORY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const ACTIVITYPODS_STORY_MAX_TTL_MS = ACTIVITYPODS_STORY_DEFAULT_TTL_MS;
export const ACTIVITYPODS_STORY_MAX_MEDIA_DURATION_MS = 60_000;
export const ACTIVITYPODS_STORY_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const CID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{10,}$/;

const storyBlobSchema = z.object({
  $type: z.literal("blob").optional(),
  ref: z.object({
    $link: z.string().regex(CID_RE),
  }),
  mimeType: z.string().min(3).max(128),
  size: z.number().int().nonnegative(),
});

const aspectRatioSchema = z.object({
  width: z.number().int().positive().max(65_535),
  height: z.number().int().positive().max(65_535),
});

export const activityPodsStoryMediaSchema = z.object({
  kind: z.enum(["image", "video"]),
  blob: storyBlobSchema,
  alt: z.string().min(1).max(1_000),
  aspectRatio: aspectRatioSchema.optional(),
  durationMs: z.number().int().positive().max(ACTIVITYPODS_STORY_MAX_MEDIA_DURATION_MS).optional(),
  preview: z.object({
    blob: storyBlobSchema,
    alt: z.string().max(1_000).optional(),
  }).optional(),
}).superRefine((media, ctx) => {
  if (media.kind === "image" && !media.blob.mimeType.startsWith("image/")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blob", "mimeType"],
      message: "image stories require an image/* blob",
    });
  }
  if (media.kind === "video" && !media.blob.mimeType.startsWith("video/")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blob", "mimeType"],
      message: "video stories require a video/* blob",
    });
  }
});

export const activityPodsStoryLinkSchema = z.object({
  uri: z.string().url().refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "story links must use http(s)",
  ),
  title: z.string().min(1).max(120).optional(),
});

export const activityPodsStoryRecordSchema = z.object({
  $type: z.literal(ACTIVITYPODS_STORY_COLLECTION),
  createdAt: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  visibility: z.enum(["public", "unlisted"]).optional(),
  media: activityPodsStoryMediaSchema,
  text: z.string().max(1_000).optional(),
  facets: z.array(z.unknown()).max(64).optional(),
  links: z.array(activityPodsStoryLinkSchema).max(4).optional(),
  labels: z.array(z.object({ val: z.string().min(1).max(128) }).passthrough()).max(16).optional(),
  allowReplies: z.boolean().optional(),
  langs: z.array(z.string().min(2).max(35)).max(8).optional(),
});

export type ActivityPodsStoryRecord = z.infer<typeof activityPodsStoryRecordSchema>;
export type ActivityPodsStoryMedia = z.infer<typeof activityPodsStoryMediaSchema>;

export interface NormalizeActivityPodsStoryOptions {
  now?: Date | string;
  requireActive?: boolean;
}

export function normalizeActivityPodsStoryRecord(
  value: unknown,
  options: NormalizeActivityPodsStoryOptions = {},
): ActivityPodsStoryRecord | null {
  const parsed = activityPodsStoryRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const now = coerceDate(options.now) ?? new Date();
  const createdAt = coerceDate(parsed.data.createdAt) ?? now;
  const expiresAt = parsed.data.expiresAt
    ? coerceDate(parsed.data.expiresAt)
    : new Date(createdAt.getTime() + ACTIVITYPODS_STORY_DEFAULT_TTL_MS);

  if (!expiresAt) {
    return null;
  }

  const ttlMs = expiresAt.getTime() - createdAt.getTime();
  if (ttlMs <= 0 || ttlMs > ACTIVITYPODS_STORY_MAX_TTL_MS) {
    return null;
  }

  if (createdAt.getTime() > now.getTime() + ACTIVITYPODS_STORY_MAX_CLOCK_SKEW_MS) {
    return null;
  }

  if (options.requireActive && expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return {
    ...parsed.data,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    visibility: parsed.data.visibility ?? "public",
    allowReplies: parsed.data.allowReplies ?? true,
  };
}

export function parseActivityPodsStoryRecord(value: unknown): ActivityPodsStoryRecord | null {
  return normalizeActivityPodsStoryRecord(value);
}

export function isActivityPodsStoryActive(
  record: ActivityPodsStoryRecord,
  now: Date | string = new Date(),
): boolean {
  const nowDate = coerceDate(now) ?? new Date();
  const expiresAt = coerceDate(record.expiresAt);
  return !!expiresAt && expiresAt.getTime() > nowDate.getTime();
}

function coerceDate(value: Date | string | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
