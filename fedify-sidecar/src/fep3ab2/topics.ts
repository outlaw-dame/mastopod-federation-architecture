import { z } from "zod";

export const NOTIFICATIONS_TOPIC = "notifications";
export const PERSONAL_FEED_TOPIC = "feeds/personal";
export const LOCAL_FEED_TOPIC = "feeds/local";
export const GLOBAL_FEED_TOPIC = "feeds/global";

export const PHASE1_STATIC_TOPICS = [
  "feeds/public/local",
  "feeds/public/remote",
  "feeds/public/unified",
  "feeds/public/canonical",
  NOTIFICATIONS_TOPIC,
  PERSONAL_FEED_TOPIC,
  LOCAL_FEED_TOPIC,
  GLOBAL_FEED_TOPIC,
] as const;

export type Phase1StaticTopic = typeof PHASE1_STATIC_TOPICS[number];

const STATIC_TOPIC_SET = new Set<string>(PHASE1_STATIC_TOPICS);
const PRIVATE_STATIC_TOPIC_SET = new Set<string>([NOTIFICATIONS_TOPIC, PERSONAL_FEED_TOPIC]);
const REPLAYABLE_STATIC_TOPIC_SET = new Set<string>([
  "feeds/public/local",
  "feeds/public/remote",
  "feeds/public/unified",
  "feeds/public/canonical",
  LOCAL_FEED_TOPIC,
  GLOBAL_FEED_TOPIC,
]);

const MAX_TOPIC_LENGTH = 4096;
const MAX_SEGMENTS = 64;
const URI_FIELD_KEYS = new Set([
  "activity",
  "actor",
  "attributedto",
  "context",
  "conversation",
  "id",
  "inreplyto",
  "object",
  "payload",
  "subject",
  "target",
  "url",
]);

export const Phase1StaticTopicSchema = z.enum(PHASE1_STATIC_TOPICS);

export type FepPublishedTopic = string;
export type FepSubscriptionTopic = string;

export const FepPublishedTopicSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TOPIC_LENGTH)
  .refine(isValidPublishedTopic, {
    message: "topic must be a supported static topic or an exact URI-derived topic",
  });

export const FepSubscriptionTopicSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TOPIC_LENGTH)
  .refine(isValidSubscriptionTopic, {
    message: "topic must be a supported static topic, URI-derived topic, or bounded wildcard pattern",
  });

export function isPhase1StaticTopic(topic: string): topic is Phase1StaticTopic {
  return STATIC_TOPIC_SET.has(topic);
}

export function isPrivateStaticTopic(topic: string): boolean {
  return PRIVATE_STATIC_TOPIC_SET.has(topic);
}

export function isReplayableTopic(topic: string): boolean {
  return REPLAYABLE_STATIC_TOPIC_SET.has(topic) || isUriDerivedTopic(topic);
}

export function isUriDerivedTopic(topic: string): boolean {
  if (!topic || isPhase1StaticTopic(topic) || hasWildcardSegments(topic)) {
    return false;
  }
  const segments = splitTopicSegments(topic);
  if (!segments || segments.length === 0) {
    return false;
  }
  const [authority, ...rest] = segments;
  if (!authority || !isValidAuthoritySegment(authority)) {
    return false;
  }
  return rest.every((segment) => isValidExactTopicSegment(segment));
}

export function isWildcardSubscription(topic: string): boolean {
  const segments = splitTopicSegments(topic);
  return !!segments?.some((segment) => segment === "+" || segment === "#");
}

export function isBoundedWildcardSubscription(topic: string): boolean {
  if (!isWildcardSubscription(topic)) {
    return false;
  }
  const segments = splitTopicSegments(topic);
  if (!segments || segments.length === 0) {
    return false;
  }
  const [first] = segments;
  if (!first || first === "+" || first === "#") {
    return false;
  }
  let wildcardCount = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "#") {
      wildcardCount += 1;
      if (index !== segments.length - 1) {
        return false;
      }
    } else if (segment === "+") {
      wildcardCount += 1;
    }
  }
  return wildcardCount > 0 && wildcardCount <= 4;
}

export function isValidPublishedTopic(topic: string): boolean {
  if (isPhase1StaticTopic(topic)) {
    return true;
  }

  const segments = splitTopicSegments(topic);
  if (!segments || segments.length === 0) {
    return false;
  }
  const [authority, ...rest] = segments;
  if (!authority || !isValidAuthoritySegment(authority)) {
    return false;
  }
  return rest.every((segment) => isValidExactTopicSegment(segment));
}

export function isValidSubscriptionTopic(topic: string): boolean {
  if (isValidPublishedTopic(topic)) {
    return true;
  }

  return isBoundedWildcardSubscription(topic);
}

export function topicMatches(subscription: string, published: string): boolean {
  if (!isValidSubscriptionTopic(subscription) || !isValidPublishedTopic(published)) {
    return false;
  }

  if (subscription === published) {
    return true;
  }

  const subscriptionSegments = splitTopicSegments(subscription);
  const publishedSegments = splitTopicSegments(published);
  if (!subscriptionSegments || !publishedSegments) {
    return false;
  }

  let subscriptionIndex = 0;
  let publishedIndex = 0;

  while (subscriptionIndex < subscriptionSegments.length && publishedIndex < publishedSegments.length) {
    const subscriptionSegment = subscriptionSegments[subscriptionIndex];
    const publishedSegment = publishedSegments[publishedIndex];

    if (subscriptionSegment === "#") {
      return true;
    }
    if (subscriptionSegment === "+") {
      subscriptionIndex += 1;
      publishedIndex += 1;
      continue;
    }
    if (subscriptionSegment !== publishedSegment) {
      return false;
    }
    subscriptionIndex += 1;
    publishedIndex += 1;
  }

  if (subscriptionIndex === subscriptionSegments.length && publishedIndex === publishedSegments.length) {
    return true;
  }

  return subscriptionIndex === subscriptionSegments.length - 1 && subscriptionSegments[subscriptionIndex] === "#";
}

export function uriToTopic(uri: string): FepPublishedTopic | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (!parsed.host) {
    return null;
  }

  const segments: string[] = [parsed.host];
  const pathSegments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => escapeWildcardCharacters(safeDecodeURIComponent(segment)));
  segments.push(...pathSegments.filter(Boolean));

  if (parsed.hash) {
    const fragment = escapeWildcardCharacters(safeDecodeURIComponent(parsed.hash.slice(1)));
    if (fragment) {
      segments.push(fragment);
    }
  }

  const topic = segments.join("/");
  return isValidPublishedTopic(topic) ? topic : null;
}

export function collectUriDerivedTopicsFromPayload(payload: unknown): FepPublishedTopic[] {
  const topics = new Set<FepPublishedTopic>();
  const visited = new Set<unknown>();

  const visit = (value: unknown, depth: number, keyHint?: string): void => {
    if (depth > 5 || topics.size >= 32) {
      return;
    }

    if (typeof value === "string") {
      if (!keyHint || URI_FIELD_KEYS.has(keyHint)) {
        const topic = uriToTopic(value);
        if (topic) {
          topics.add(topic);
        }
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 16)) {
        visit(item, depth + 1, keyHint);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const objectId = record["id"];
    if (typeof objectId === "string") {
      const topic = uriToTopic(objectId);
      if (topic) {
        topics.add(topic);
      }
    }

    for (const [rawKey, child] of Object.entries(record).slice(0, 40)) {
      const key = normalizeFieldKey(rawKey);
      if (URI_FIELD_KEYS.has(key) || depth < 2) {
        visit(child, depth + 1, key);
      }
    }
  };

  visit(payload, 0);
  return Array.from(topics).sort();
}

export function classifyTopicForMetrics(topic: string): string {
  if (isPhase1StaticTopic(topic)) {
    return topic;
  }
  return isPrivateStaticTopic(topic) ? "private" : "uri";
}

function splitTopicSegments(topic: string): string[] | null {
  const trimmed = topic.trim();
  if (!trimmed || trimmed.length > MAX_TOPIC_LENGTH) {
    return null;
  }
  const segments = trimmed.split("/");
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) {
    return null;
  }
  if (segments.some((segment) => !segment)) {
    return null;
  }
  return segments;
}

function isValidAuthoritySegment(segment: string): boolean {
  if (!segment || segment.length > 255) {
    return false;
  }
  if (segment.includes("+") || segment.includes("#")) {
    return false;
  }
  return !containsControlOrWhitespace(segment);
}

function isValidExactTopicSegment(segment: string): boolean {
  if (!segment || segment.length > 255) {
    return false;
  }
  if (segment === "+" || segment === "#") {
    return false;
  }
  if (segment.includes("+") || segment.includes("#")) {
    return false;
  }
  return !containsControlOrWhitespace(segment);
}

function hasWildcardSegments(topic: string): boolean {
  const segments = splitTopicSegments(topic);
  return !!segments?.some((segment) => segment === "+" || segment === "#");
}

function containsControlOrWhitespace(value: string): boolean {
  return /[\u0000-\u001F\u007F\s]/u.test(value);
}

function escapeWildcardCharacters(value: string): string {
  return value.replace(/\+/g, "%2B").replace(/#/g, "%23");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFieldKey(rawKey: string): string {
  const lower = rawKey.toLowerCase();
  const hashIndex = lower.lastIndexOf("#");
  const slashIndex = lower.lastIndexOf("/");
  const colonIndex = lower.lastIndexOf(":");
  const index = Math.max(hashIndex, slashIndex, colonIndex);
  return index >= 0 ? lower.slice(index + 1) : lower;
}
