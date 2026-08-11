import { createHash } from "node:crypto";
import { z } from "zod";

export const ACTIVITYPUB_DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_FIXTURE_SHA256 =
  "0d38040d212f781deb71fc8a62c9f4a6bef60ef977414369e9b8a41df0d1b09a" as const;
export const ACTIVITYPUB_DELIVERY_PLAN_JSON_SCHEMA_SHA256 =
  "36ca416cc862c895ca87ff00a85facdd9ad171d9e214e9d0685e4c46fef5d6af" as const;

const APDM_INTENT_ID_PATTERN = /^apdm-v1-[a-f0-9]{64}$/u;
const UNSAFE_TOKEN_PATTERN = /[\s\u0000-\u001f\u007f]/u;
const ACTIVITYSTREAMS_NAMESPACE = "https://www.w3.org/ns/activitystreams#";
const ADDRESSING_TERMS = new Set(["to", "bto", "cc", "bcc", "audience"]);
const PUBLIC_ADDRESSES = new Set([
  `${ACTIVITYSTREAMS_NAMESPACE}Public`,
  "as:Public",
  "Public",
]);

type ContextState = {
  prefixes: Map<string, string>;
  aliases: Map<string, string>;
};

function isCleanString(value: string): boolean {
  return value.length > 0 && !UNSAFE_TOKEN_PATTERN.test(value);
}

function assertDenseArray(value: unknown[], label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError(`Cannot ${label} sparse array`);
    }
  }
}

function parseSafeHttpUrl(value: string): URL | null {
  if (!isCleanString(value)) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
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
  if (!parsed || value.includes("#")) return null;
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

const localDeliveryTargetSchema = z.object({
  actorUri: httpUrlSchema,
  dataset: cleanOpaqueStringSchema,
  inboxUri: deliveryEndpointUrlSchema,
}).strict();

const remoteDeliveryTargetSchema = z.object({
  actorUri: httpUrlSchema,
  inboxUrl: deliveryEndpointUrlSchema,
  sharedInboxUrl: deliveryEndpointUrlSchema.optional(),
  targetDomain: cleanOpaqueStringSchema,
}).strict().superRefine((target, ctx) => {
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

function resolveAddressingDefinition(definition: unknown, prefixes: Map<string, string>): string | null {
  const raw = typeof definition === "string"
    ? definition
    : definition !== null && typeof definition === "object" && !Array.isArray(definition)
      ? (definition as Record<string, unknown>)["@id"]
      : null;
  if (typeof raw !== "string") return null;
  if (raw.startsWith(ACTIVITYSTREAMS_NAMESPACE)) {
    const term = raw.slice(ACTIVITYSTREAMS_NAMESPACE.length);
    return ADDRESSING_TERMS.has(term) ? term : null;
  }
  const separator = raw.indexOf(":");
  if (separator > 0) {
    const prefix = raw.slice(0, separator);
    const suffix = raw.slice(separator + 1);
    if (prefixes.get(prefix) === ACTIVITYSTREAMS_NAMESPACE && ADDRESSING_TERMS.has(suffix)) return suffix;
  }
  return ADDRESSING_TERMS.has(raw) ? raw : null;
}

function buildContextState(context: unknown, inherited?: ContextState): ContextState {
  const prefixes = new Map<string, string>(inherited?.prefixes ?? [["as", ACTIVITYSTREAMS_NAMESPACE]]);
  const aliases = new Map<string, string>(inherited?.aliases ?? []);
  const entries = Array.isArray(context) ? context : context === undefined ? [] : [context];

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    for (const [key, definition] of Object.entries(record)) {
      const raw = typeof definition === "string"
        ? definition
        : definition !== null && typeof definition === "object" && !Array.isArray(definition)
          ? (definition as Record<string, unknown>)["@id"]
          : null;
      if (raw === ACTIVITYSTREAMS_NAMESPACE) prefixes.set(key, ACTIVITYSTREAMS_NAMESPACE);
    }
    for (const [key, definition] of Object.entries(record)) {
      const term = resolveAddressingDefinition(definition, prefixes);
      if (term) aliases.set(key, term);
    }
  }
  return { prefixes, aliases };
}

function canonicalAddressingTerm(key: string, state: ContextState): string | null {
  if (ADDRESSING_TERMS.has(key)) return key;
  if (key.startsWith(ACTIVITYSTREAMS_NAMESPACE)) {
    const term = key.slice(ACTIVITYSTREAMS_NAMESPACE.length);
    return ADDRESSING_TERMS.has(term) ? term : null;
  }
  const separator = key.indexOf(":");
  if (separator > 0) {
    const prefix = key.slice(0, separator);
    const suffix = key.slice(separator + 1);
    if (state.prefixes.get(prefix) === ACTIVITYSTREAMS_NAMESPACE && ADDRESSING_TERMS.has(suffix)) return suffix;
  }
  return state.aliases.get(key) ?? null;
}

function addressingValues(activity: Record<string, unknown>, term: string): string[] {
  const state = buildContextState(activity["@context"]);
  const values: string[] = [];
  for (const [key, value] of Object.entries(activity)) {
    if (canonicalAddressingTerm(key, state) === term) values.push(...normalizedAddresses(value));
  }
  return values;
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
  const to = addressingValues(activity, "to");
  const cc = addressingValues(activity, "cc");
  if (to.some((value) => PUBLIC_ADDRESSES.has(value))) return "public";
  if (cc.some((value) => PUBLIC_ADDRESSES.has(value))) return "unlisted";
  const actorUri = normalizeId(activity["actor"]);
  if (actorUri && to.some((value) => isActorFollowersAddress(value, actorUri))) return "followers";
  return "direct";
}

function hasSenderFollowersAudience(activity: Record<string, unknown>): boolean {
  const actorUri = normalizeId(activity["actor"]);
  return Boolean(actorUri && addressingValues(activity, "audience")
    .some((value) => isActorFollowersAddress(value, actorUri)));
}

function getExplicitConcreteRecipientUris(activity: Record<string, unknown>): string[] {
  const actorUri = normalizeId(activity["actor"]);
  const addresses = [...ADDRESSING_TERMS].flatMap((term) => addressingValues(activity, term));
  return [...new Set(addresses.filter((value) => {
    if (PUBLIC_ADDRESSES.has(value)) return false;
    if (actorUri && isActorFollowersAddress(value, actorUri)) return false;
    return true;
  }))];
}

function containsBlindAudienceFields(
  value: unknown,
  seen = new WeakSet<object>(),
  inheritedContext?: ContextState,
): boolean {
  if (value === null || typeof value !== "object") return false;
  const objectValue = value as object;
  if (seen.has(objectValue)) return false;
  seen.add(objectValue);
  if (Array.isArray(value)) return value.some((item) => containsBlindAudienceFields(item, seen, inheritedContext));
  const record = value as Record<string, unknown>;
  const state = buildContextState(record["@context"], inheritedContext);
  if (Object.keys(record).some((key) => {
    const term = canonicalAddressingTerm(key, state);
    return term === "bto" || term === "bcc";
  })) return true;
  return Object.values(record).some((item) => containsBlindAudienceFields(item, seen, state));
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

export const activityPubDeliveryPlanV1Schema = z.object({
  schema: z.literal(ACTIVITYPUB_DELIVERY_PLAN_SCHEMA),
  intentId: z.string().regex(APDM_INTENT_ID_PATTERN),
  activityId: httpUrlSchema,
  actorUri: httpUrlSchema,
  activity: z.record(z.unknown()),
  localRecipients: z.array(localDeliveryTargetSchema),
  remoteRecipients: z.array(remoteDeliveryTargetSchema),
  meta: z.object({
    visibility: z.enum(["public", "unlisted", "followers", "direct"]),
    isPublicActivity: z.boolean(),
    isPublicIndexable: z.boolean().optional(),
    searchConsent: z.record(z.unknown()).nullable().optional(),
  }).strict(),
}).strict().superRefine((plan, ctx) => {
  const embeddedActivityId = normalizeId(plan.activity["id"] ?? plan.activity["@id"]);
  if (embeddedActivityId !== plan.activityId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activity"], message: "embedded Activity id must match activityId" });
  }
  const embeddedActorUri = normalizeId(plan.activity["actor"]);
  if (embeddedActorUri !== plan.actorUri) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activity"], message: "embedded Activity actor must match actorUri" });
  }
  if (containsBlindAudienceFields(plan.activity)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activity"],
      message: "outbound Activity payload must not disclose bto/bcc blind addressing",
    });
  }
  if (hasSenderFollowersAudience(plan.activity)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activity", "audience"],
      message: "sender followers in audience require authoritative expansion before external delivery",
    });
  }

  const expectedVisibility = determineActivityVisibility(plan.activity);
  if (plan.meta.visibility !== expectedVisibility) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meta", "visibility"], message: `visibility must agree with embedded Activity addressing (${expectedVisibility})` });
  }
  const expectedPublic = expectedVisibility === "public" || expectedVisibility === "unlisted";
  if (plan.meta.isPublicActivity !== expectedPublic) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meta", "isPublicActivity"], message: "isPublicActivity must agree with visibility" });
  }
  if (plan.meta.isPublicIndexable === true && !expectedPublic) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meta", "isPublicIndexable"], message: "private/followers/direct Activities cannot be public-indexable" });
  }

  const localUris = plan.localRecipients.map((target) => target.actorUri);
  const remoteUris = plan.remoteRecipients.map((target) => target.actorUri);
  if (new Set(localUris).size !== localUris.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["localRecipients"], message: "local recipient actorUri values must be unique" });
  }
  if (new Set(remoteUris).size !== remoteUris.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remoteRecipients"], message: "remote recipient actorUri values must be unique" });
  }
  const localSet = new Set(localUris);
  if (remoteUris.some((uri) => localSet.has(uri))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remoteRecipients"], message: "an actor cannot be both a local and remote recipient" });
  }

  const plannedRecipients = new Set([...localUris, ...remoteUris]);
  const omittedExplicitRecipient = getExplicitConcreteRecipientUris(plan.activity)
    .find((uri) => !plannedRecipients.has(uri));
  if (omittedExplicitRecipient) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remoteRecipients"],
      message: `Delivery Plan omits explicitly addressed recipient ${omittedExplicitRecipient}`,
    });
  }

  const expectedIntentId = computeExpectedIntentId({
    activityId: plan.activityId,
    actorUri: plan.actorUri,
    localRecipientUris: localUris,
    remoteRecipientUris: remoteUris,
  });
  if (plan.intentId !== expectedIntentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intentId"], message: "intentId does not match the canonical Activity/recipient identity" });
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
    assertDenseArray(value, "canonicalize");
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
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Cannot canonicalize non-JSON object");
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeDeliveryPlanValue(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize unsupported ${typeof value} value`);
  }
}

export function activityPubDeliveryPlanFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalizeDeliveryPlanValue(value)).digest("hex");
}
