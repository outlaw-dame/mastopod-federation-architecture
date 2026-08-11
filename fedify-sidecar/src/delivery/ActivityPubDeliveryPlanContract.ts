import { createHash } from "node:crypto";
import { z } from "zod";

export const ACTIVITYPUB_DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_FIXTURE_SHA256 =
  "0d38040d212f781deb71fc8a62c9f4a6bef60ef977414369e9b8a41df0d1b09a" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_JSON_SCHEMA_SHA256 =
  "737f98bbda5c34fb26803c21abad1049c47b62643bcd4e162e017625ba380a9d" as const;

const APDM_INTENT_ID_PATTERN = /^apdm-v1-[a-f0-9]{64}$/u;
const PUBLIC_ADDRESSES = new Set([
  "https://www.w3.org/ns/activitystreams#Public",
  "as:Public",
  "Public",
]);

const httpUrlSchema = z.string().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}, "Expected an HTTP(S) URL without embedded credentials");

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
  .strict()
  .superRefine((target, ctx) => {
    const deliveryUrl = target.sharedInboxUrl ?? target.inboxUrl;
    const expectedDomain = new URL(deliveryUrl).hostname.toLowerCase();
    if (target.targetDomain !== expectedDomain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetDomain"],
        message: `targetDomain must match delivery URL hostname ${expectedDomain}`,
      });
    }
  });

function normalizeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const id = record["id"] ?? record["@id"];
    return typeof id === "string" ? id : null;
  }
  return null;
}

function normalizedAddresses(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(normalizeId).filter((item): item is string => typeof item === "string");
}

function isFollowersAddress(value: string): boolean {
  try {
    return new URL(value).pathname.replace(/\/+$/u, "").endsWith("/followers");
  } catch {
    return false;
  }
}

function determineActivityVisibility(activity: Record<string, unknown>): "public" | "unlisted" | "followers" | "direct" {
  const to = normalizedAddresses(activity["to"]);
  const cc = normalizedAddresses(activity["cc"]);
  if (to.some((value) => PUBLIC_ADDRESSES.has(value))) return "public";
  if (cc.some((value) => PUBLIC_ADDRESSES.has(value))) return "unlisted";
  if (to.some(isFollowersAddress)) return "followers";
  return "direct";
}

function computeExpectedIntentId(input: {
  activityId: string;
  actorUri: string;
  localRecipientUris: string[];
  remoteRecipientUris: string[];
}): string {
  const material = canonicalizeDeliveryPlanValue({
    schema: ACTIVITYPUB_DELIVERY_PLAN_SCHEMA,
    activityId: input.activityId,
    actorUri: input.actorUri,
    localRecipientUris: [...new Set(input.localRecipientUris)].sort(),
    remoteRecipientUris: [...new Set(input.remoteRecipientUris)].sort(),
  });
  return `apdm-v1-${createHash("sha256").update(material).digest("hex")}`;
}

export const activityPubDeliveryPlanV1Schema = z
  .object({
    schema: z.literal(ACTIVITYPUB_DELIVERY_PLAN_SCHEMA),
    intentId: z.string().regex(APDM_INTENT_ID_PATTERN),
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
  .strict()
  .superRefine((plan, ctx) => {
    const embeddedActivityId = normalizeId(plan.activity["id"] ?? plan.activity["@id"]);
    if (embeddedActivityId !== plan.activityId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity"],
        message: "embedded Activity id must match activityId",
      });
    }

    const embeddedActorUri = normalizeId(plan.activity["actor"]);
    if (embeddedActorUri !== plan.actorUri) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity"],
        message: "embedded Activity actor must match actorUri",
      });
    }

    const expectedVisibility = determineActivityVisibility(plan.activity);
    if (plan.meta.visibility !== expectedVisibility) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "visibility"],
        message: `visibility must agree with embedded Activity addressing (${expectedVisibility})`,
      });
    }
    const expectedPublic = expectedVisibility === "public" || expectedVisibility === "unlisted";
    if (plan.meta.isPublicActivity !== expectedPublic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "isPublicActivity"],
        message: "isPublicActivity must agree with visibility",
      });
    }
    if (plan.meta.isPublicIndexable === true && !expectedPublic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "isPublicIndexable"],
        message: "private/followers/direct Activities cannot be public-indexable",
      });
    }

    const localUris = plan.localRecipients.map((target) => target.actorUri);
    const remoteUris = plan.remoteRecipients.map((target) => target.actorUri);
    if (new Set(localUris).size !== localUris.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localRecipients"],
        message: "local recipient actorUri values must be unique",
      });
    }
    if (new Set(remoteUris).size !== remoteUris.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remoteRecipients"],
        message: "remote recipient actorUri values must be unique",
      });
    }
    const localSet = new Set(localUris);
    if (remoteUris.some((uri) => localSet.has(uri))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remoteRecipients"],
        message: "an actor cannot be both a local and remote recipient",
      });
    }

    const expectedIntentId = computeExpectedIntentId({
      activityId: plan.activityId,
      actorUri: plan.actorUri,
      localRecipientUris: localUris,
      remoteRecipientUris: remoteUris,
    });
    if (plan.intentId !== expectedIntentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intentId"],
        message: "intentId does not match the canonical Activity/recipient identity",
      });
    }
  });

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
