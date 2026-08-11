import { createHash } from "node:crypto";
import { z } from "zod";

export const ACTIVITYPUB_DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_FIXTURE_SHA256 =
  "0d38040d212f781deb71fc8a62c9f4a6bef60ef977414369e9b8a41df0d1b09a" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_JSON_SCHEMA_SHA256 =
  "36ca416cc862c895ca87ff00a85facdd9ad171d9e214e9d0685e4c46fef5d6af" as const;

const APDM_INTENT_ID_PATTERN = /^apdm-v1-[a-f0-9]{64}$/u;
const UNSAFE_TOKEN_PATTERN = /[\s\u0000-\u001f\u007f]/u;
const PUBLIC_ADDRESSES = new Set([
  "https://www.w3.org/ns/activitystreams#Public",
  "as:Public",
  "Public",
]);

function isCleanString(value: string): boolean {
  return value.length > 0 && !UNSAFE_TOKEN_PATTERN.test(value);
}

function parseSafeHttpUrl(value: string): URL | null {
  if (!isCleanString(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeDeliveryTargetDomain(value: string): string | null {
  if (!isCleanString(value)) return null;
  const normalized = value.toLowerCase().replace(/\.+$/u, "");
  return normalized.length > 0 ? normalized : null;
}

function parseDeliveryEndpointUrl(value: string): URL | null {
  const parsed = parseSafeHttpUrl(value);
  if (!parsed || parsed.hash) return null;
  return normalizeDeliveryTargetDomain(parsed.hostname) ? parsed : null;
}

const httpUrlSchema = z.string().url().refine(
  (value) => parseSafeHttpUrl(value) !== null,
  "Expected an HTTP(S) URL without credentials, whitespace, or control characters",
);

const deliveryEndpointUrlSchema = z.string().url().refine(
  (value) => parseDeliveryEndpointUrl(value) !== null,
  "Expected a fragment-free HTTP(S) delivery URL without credentials, whitespace, or control characters",
);

const cleanOpaqueStringSchema = z.string().min(1).refine(
  isCleanString,
  "Expected a non-empty string without whitespace or control characters",
);

const localDeliveryTargetSchema = z
  .object({
    actorUri: httpUrlSchema,
    dataset: cleanOpaqueStringSchema,
    inboxUri: deliveryEndpointUrlSchema,
  })
  .strict();

const remoteDeliveryTargetSchema = z
  .object({
    actorUri: httpUrlSchema,
    inboxUrl: deliveryEndpointUrlSchema,
    sharedInboxUrl: deliveryEndpointUrlSchema.optional(),
    targetDomain: cleanOpaqueStringSchema,
  })
  .strict()
  .superRefine((target, ctx) => {
    const deliveryUrl = target.sharedInboxUrl ?? target.inboxUrl;
    const parsedDeliveryUrl = parseDeliveryEndpointUrl(deliveryUrl);
    if (!parsedDeliveryUrl) return;

    const expectedDomain = normalizeDeliveryTargetDomain(parsedDeliveryUrl.hostname);
    if (!expectedDomain || target.targetDomain !== expectedDomain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetDomain"],
        message: `targetDomain must match canonical delivery URL hostname ${expectedDomain ?? "<invalid>"}`,
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

function isActorFollowersAddress(value: string, actorUri: string): boolean {
  try {
    const address = new URL(value);
    const actor = new URL(actorUri);
    if (actor.search || actor.hash || address.search || address.hash) return false;
    if (address.origin !== actor.origin) return false;
    const actorPath = actor.pathname.replace(/\/+$/u, "");
    const addressPath = address.pathname.replace(/\/+$/u, "");
    return addressPath === `${actorPath}/followers`;
  } catch {
    return false;
  }
}

function determineActivityVisibility(activity: Record<string, unknown>): "public" | "unlisted" | "followers" | "direct" {
  const to = normalizedAddresses(activity["to"]);
  const cc = normalizedAddresses(activity["cc"]);
  if (to.some((value) => PUBLIC_ADDRESSES.has(value))) return "public";
  if (cc.some((value) => PUBLIC_ADDRESSES.has(value))) return "unlisted";
  const actorUri = normalizeId(activity["actor"]);
  if (actorUri && to.some((value) => isActorFollowersAddress(value, actorUri))) return "followers";
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
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeDeliveryPlanValue).join(",")}]`;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize non-finite number");
      return JSON.stringify(value);
    case "object": {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Cannot canonicalize non-JSON object");
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalizeDeliveryPlanValue(record[key])}`)
        .join(",")}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize unsupported ${typeof value} value`);
  }
}

export function activityPubDeliveryPlanFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalizeDeliveryPlanValue(value)).digest("hex");
}
