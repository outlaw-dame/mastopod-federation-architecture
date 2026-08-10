import { createHash } from "node:crypto";
import { z } from "zod";

export const ACTIVITYPUB_DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_FIXTURE_SHA256 =
  "8a772d3c6d0555c9419ecf62f06e970ca0f82440f00db0c75b645f47fcaa27d7" as const;

const localDeliveryTargetSchema = z
  .object({
    actorUri: z.string().url(),
    dataset: z.string().min(1),
    inboxUri: z.string().url(),
  })
  .strict();

const remoteDeliveryTargetSchema = z
  .object({
    actorUri: z.string().url(),
    inboxUrl: z.string().url(),
    sharedInboxUrl: z.string().url().optional(),
    targetDomain: z.string().min(1),
  })
  .strict();

export const activityPubDeliveryPlanV1Schema = z
  .object({
    schema: z.literal(ACTIVITYPUB_DELIVERY_PLAN_SCHEMA),
    intentId: z.string().min(1),
    activityId: z.string().url(),
    actorUri: z.string().url(),
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
