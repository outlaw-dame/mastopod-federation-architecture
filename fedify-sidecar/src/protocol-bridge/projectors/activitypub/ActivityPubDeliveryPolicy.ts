import { sanitizeJsonObject } from "../../../utils/safe-json.js";
import type { ActivityPubBridgeActivityHints } from "../../events/ActivityPubBridgeEvents.js";
import type { ActivityPubNoteLinkPreviewMode } from "./ActivityPubProjectionPolicy.js";

export interface ActivityPubOutboundDeliveryPolicy {
  defaultNoteLinkPreviewMode: ActivityPubNoteLinkPreviewMode;
  richNoteLinkPreviewDomains: readonly string[];
  disabledNoteLinkPreviewDomains: readonly string[];
}

export const DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY: ActivityPubOutboundDeliveryPolicy = {
  defaultNoteLinkPreviewMode: "attachment_only",
  richNoteLinkPreviewDomains: [],
  disabledNoteLinkPreviewDomains: [],
};

export function normalizeActivityPubDomainRuleList(
  value: string | null | undefined,
): string[] {
  if (!value) {
    return [];
  }

  const normalized = new Set<string>();
  for (const token of value.split(/[,\n]/)) {
    const candidate = normalizeDomainRule(token);
    if (candidate) {
      normalized.add(candidate);
    }
  }

  return [...normalized];
}

export function resolveOutboundNoteLinkPreviewMode(
  targetDomain: string,
  policy: ActivityPubOutboundDeliveryPolicy = DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY,
): ActivityPubNoteLinkPreviewMode {
  const normalizedDomain = normalizeDomainRule(targetDomain);
  if (!normalizedDomain) {
    return policy.defaultNoteLinkPreviewMode;
  }

  if (domainMatchesAny(normalizedDomain, policy.disabledNoteLinkPreviewDomains)) {
    return "disabled";
  }

  if (domainMatchesAny(normalizedDomain, policy.richNoteLinkPreviewDomains)) {
    return "attachment_and_preview";
  }

  return policy.defaultNoteLinkPreviewMode;
}

export function applyActivityPubOutboundDeliveryPolicy(
  activity: Record<string, unknown>,
  targetDomain: string,
  hints: ActivityPubBridgeActivityHints | null | undefined,
  policy: ActivityPubOutboundDeliveryPolicy = DEFAULT_ACTIVITYPUB_OUTBOUND_DELIVERY_POLICY,
): Record<string, unknown> {
  const previewUrls = new Set(normalizeHintPreviewUrls(hints?.noteLinkPreviewUrls));
  const sanitized = sanitizeJsonObject(activity);
  if (previewUrls.size === 0) {
    return sanitized;
  }

  const target = resolveNoteObject(sanitized);
  if (!target) {
    return sanitized;
  }

  const attachmentItems = toObjectArray(target["attachment"]);
  const previewCard = toObject(target["preview"]);
  const matchingPreview = isMatchingNoteLinkPreviewCard(previewCard, previewUrls)
    ? previewCard
    : null;
  const matchingAttachments = attachmentItems.filter((item) => isMatchingNoteLinkPreviewCard(item, previewUrls));
  const representativeCard = matchingPreview ?? matchingAttachments[0] ?? null;
  if (!representativeCard) {
    return sanitized;
  }

  const mode = resolveOutboundNoteLinkPreviewMode(targetDomain, policy);
  if (mode === "disabled") {
    const remainingAttachments = attachmentItems.filter((item) => !isMatchingNoteLinkPreviewCard(item, previewUrls));
    replaceArrayProperty(target, "attachment", remainingAttachments);
    if (matchingPreview) {
      delete target["preview"];
    }
    return sanitized;
  }

  const dedupedAttachments = dedupeAttachmentCards([
    ...attachmentItems,
    ...matchingAttachments,
    representativeCard,
  ]);
  replaceArrayProperty(target, "attachment", dedupedAttachments);

  if (mode === "attachment_and_preview") {
    target["preview"] = { ...representativeCard };
    return sanitized;
  }

  if (matchingPreview) {
    delete target["preview"];
  }

  return sanitized;
}

function normalizeHintPreviewUrls(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = new Set<string>();
  for (const value of values) {
    const url = normalizeHttpUrl(value);
    if (url) {
      normalized.add(url);
    }
  }

  return [...normalized];
}

function resolveNoteObject(activity: Record<string, unknown>): Record<string, unknown> | null {
  const object = toObject(activity["object"]);
  if (object && object["type"] === "Note") {
    return object;
  }

  return activity["type"] === "Note" ? activity : null;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toObjectArray(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((entry) => toObject(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function replaceArrayProperty(
  object: Record<string, unknown>,
  key: string,
  values: Record<string, unknown>[],
): void {
  if (values.length === 0) {
    delete object[key];
    return;
  }

  object[key] = values;
}

function dedupeAttachmentCards(cards: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const deduped = new Map<string, Record<string, unknown>>();
  for (const card of cards) {
    const key = buildCardKey(card);
    if (!deduped.has(key)) {
      deduped.set(key, { ...card });
    }
  }

  return [...deduped.values()];
}

function buildCardKey(card: Record<string, unknown>): string {
  const type = typeof card["type"] === "string" ? card["type"] : "";
  const mediaType = typeof card["mediaType"] === "string" ? card["mediaType"] : "";
  const url = typeof card["url"] === "string" ? card["url"] : "";
  return `${type}|${mediaType}|${url}`;
}

function isMatchingNoteLinkPreviewCard(
  value: Record<string, unknown> | null,
  previewUrls: ReadonlySet<string>,
): boolean {
  if (!value) {
    return false;
  }

  if (value["type"] !== "Document") {
    return false;
  }

  const mediaType = value["mediaType"];
  if (typeof mediaType === "string" && mediaType !== "text/html") {
    return false;
  }

  const url = normalizeHttpUrl(typeof value["url"] === "string" ? value["url"] : null);
  if (!url || !previewUrls.has(url)) {
    return false;
  }

  return typeof value["name"] === "string" && value["name"].trim().length > 0;
}

function domainMatchesAny(domain: string, rules: readonly string[]): boolean {
  return rules.some((rule) => domain === rule || domain.endsWith(`.${rule}`));
}

function normalizeDomainRule(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return null;
  }

  return parsed.hostname.replace(/\.$/, "");
}

function normalizeHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return parsed.toString();
}
