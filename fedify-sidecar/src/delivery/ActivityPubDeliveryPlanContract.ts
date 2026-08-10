import { createHash } from "node:crypto";
import { z } from "zod";

export const ACTIVITYPUB_DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_FIXTURE_SHA256 =
  "8a772d3c6d0555c9419ecf62f06e970ca0f82440f00db0c75b645f47fcaa27d7" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_JSON_SCHEMA_SHA256 =
  "555094968f8372e2e2438bf1dc6eae69d2f2541231d3a4aa7ce7efee8f5fcd9f" as const;

const httpUrlSchema = z.string().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "Expected an HTTP(S) URL");

const localDeliveryTargetSchema = z
  .object({
    actorUri: httpUrlSchema,
    dataset: z.string().min(1),
    inboxUri: httpUrlSchema,
  })
  .strict();

const remoteDeliveryTargetSchema = z
  .object({
    actorUri: httpUrlSchema,
    inboxUrl: httpUrlSchema,
    sharedInboxUrl: httpUrlSchema.optional(),
    targetDomain: z.string().min(1),
  })
  .strict();

export const activityPubDeliveryPlanV1Schema = z
  .object({
    schema: z.literal(ACTIVITYPUB_DELIVERY_PLAN_SCHEMA),
    intentId: z.string().min(1),
    activityId: httpUrlSchema,
    actorUri: httpUrlSchema,
    activity: z.record(z.unknown()),
    localRecipients: z.array(localDeliveryTargetSchema),
    remoteRecipients: z.array(remoteDeliveryTargetSchema),
    meta: z
      .object({
        visibility: z.enum(["public", "unlisted", "followers", "direct"]),
        isPublicActivity: z.boolean(),
        isPublicIndexable: z.boolean().optional(),
        searchConsent: z.record(z.unknown()).nullable().optional(),
      })
      .strict(),
  })
  .strict();

export type ActivityPubDeliveryPlanV1 = z.infer<typeof activityPubDeliveryPlanV1Schema>;
export type LocalDeliveryTargetV1 = ActivityPubDeliveryPlanV1["localRecipients"][number];
export type RemoteDeliveryTargetV1 = ActivityPubDeliveryPlanV1["remoteRecipients"][number];

export function parseActivityPubDeliveryPlanV1(value: unknown): ActivityPubDeliveryPlanV1 {
  return activityPubDeliveryPlanV1Schema.parse(value);
}

export function safeParseActivityPubDeliveryPlanV1(value: unknown) {
  return activityPubDeliveryPlanV1Schema.safeParse(value);
}

export function canonicalizeDeliveryPlanValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeDeliveryPlanValue).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeDeliveryPlanValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function activityPubDeliveryPlanFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalizeDeliveryPlanValue(value)).digest("hex");
}
