/**
 * CanonicalIntentPublisher
 *
 * Serializes every translated CanonicalIntent to `canonical.v1` BEFORE
 * projection to either protocol. This creates a durable, protocol-neutral
 * event log that downstream consumers (notification fan-out, analytics,
 * search indexing, replay) can subscribe to without knowing the source
 * protocol.
 *
 * Only "native" intents are published — "mirrored" intents (those that
 * originated as a projection from the other protocol) are skipped to
 * prevent the canonical topic from containing duplicates.
 *
 * Consumers:
 *   - CanonicalNotificationConsumer  → in-app notifications via ActivityPods
 *   - Future: search indexer, feed aggregator, audit trail
 */

import type { CanonicalIntent } from "./CanonicalIntent.js";
import type { CanonicalFacet } from "./CanonicalContent.js";
import type { CanonicalV1Event, CanonicalV1ActorRef, CanonicalV1ObjectRef } from "../../streams/v6-topology.js";

export const CANONICAL_V1_TOPIC = "canonical.v1";
const MAX_CANONICAL_CONTENT_TEXT_LENGTH = 1_000;

// Minimal structural publisher interface — satisfied by RedpandaEventPublisher.
export interface CanonicalRawPublisher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(topic: string, event: any, metadata?: Record<string, unknown>): Promise<void>;
}

export class CanonicalIntentPublisher {
  constructor(
    private readonly publisher: CanonicalRawPublisher,
    private readonly topic: string = CANONICAL_V1_TOPIC,
  ) {}

  /**
   * Publish a translated intent. Silently skips mirrored intents.
   * Errors are propagated — callers decide whether to swallow or rethrow.
   */
  async publish(intent: CanonicalIntent): Promise<void> {
    if (intent.provenance.projectionMode === "mirrored") {
      return;
    }

    const event = serializeIntent(intent);
    await this.publisher.publish(this.topic, event, {
      correlationId: intent.canonicalIntentId,
      partitionKey: resolvePartitionKey(intent),
      source: "canonical-bridge",
    });
  }
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/**
 * Convert a CanonicalIntent to the CanonicalV1Event wire format that is
 * written to the canonical.v1 Kafka topic.
 *
 * Exported so that observe-only paths (e.g. UnifiedFeedBridge) can produce
 * the same payload shape without going through the Kafka publisher.
 */
export function serializeCanonicalIntent(intent: CanonicalIntent): CanonicalV1Event {
  return serializeIntent(intent);
}

function serializeIntent(intent: CanonicalIntent): CanonicalV1Event {
  const actor: CanonicalV1ActorRef = {
    canonicalAccountId: intent.sourceAccountRef.canonicalAccountId ?? null,
    did: intent.sourceAccountRef.did ?? null,
    webId: intent.sourceAccountRef.webId ?? null,
    activityPubActorUri: intent.sourceAccountRef.activityPubActorUri ?? null,
    handle: intent.sourceAccountRef.handle ?? null,
  };

  const base: CanonicalV1Event = {
    canonicalIntentId: intent.canonicalIntentId,
    kind: intent.kind,
    sourceProtocol: intent.sourceProtocol,
    sourceEventId: intent.sourceEventId,
    visibility: intent.visibility,
    actor,
    createdAt: intent.createdAt,
    observedAt: intent.observedAt,
    timestamp: Date.now(),
  };

  // Attach object ref for action kinds that have a target object
  if (
    intent.kind === "PostCreate" ||
    intent.kind === "PostEdit" ||
    intent.kind === "PostDelete" ||
    intent.kind === "PostInteractionPolicyUpdate" ||
    intent.kind === "PollCreate" ||
    intent.kind === "PollEdit" ||
    intent.kind === "PollDelete" ||
    intent.kind === "PollVoteAdd" ||
    intent.kind === "ReactionAdd" ||
    intent.kind === "ReactionRemove" ||
    intent.kind === "ShareAdd" ||
    intent.kind === "ShareRemove" ||
    intent.kind === "ReportCreate" ||
    ((intent.kind === "FollowAdd" || intent.kind === "FollowRemove") && Boolean(intent.targetObject))
  ) {
    const obj =
      intent.kind === "FollowAdd" || intent.kind === "FollowRemove"
        ? intent.targetObject!
        : intent.kind === "ReportCreate"
          ? intent.subject.kind === "object"
            ? intent.subject.object
            : null
          : intent.object;
    if (obj) {
      const objectRef: CanonicalV1ObjectRef = {
        canonicalObjectId: obj.canonicalObjectId,
        atUri: obj.atUri ?? null,
        activityPubObjectId: obj.activityPubObjectId ?? null,
        canonicalUrl: obj.canonicalUrl ?? null,
      };
      base.object = objectRef;
    }
  }

  // Attach subject ref for follow actions
  if (intent.kind === "FollowAdd" || intent.kind === "FollowRemove") {
    if (intent.subject) {
      base.subject = {
        canonicalAccountId: intent.subject.canonicalAccountId ?? null,
        did: intent.subject.did ?? null,
        activityPubActorUri: intent.subject.activityPubActorUri ?? null,
        handle: intent.subject.handle ?? null,
      };
    }
  }

  if (intent.kind === "ReportCreate") {
    if (intent.subject.kind === "account") {
      base.subject = {
        canonicalAccountId: intent.subject.actor.canonicalAccountId ?? null,
        did: intent.subject.actor.did ?? null,
        webId: intent.subject.actor.webId ?? null,
        activityPubActorUri: intent.subject.actor.activityPubActorUri ?? null,
        handle: intent.subject.actor.handle ?? null,
      };
    } else if (intent.subject.owner) {
      base.subject = {
        canonicalAccountId: intent.subject.owner.canonicalAccountId ?? null,
        did: intent.subject.owner.did ?? null,
        webId: intent.subject.owner.webId ?? null,
        activityPubActorUri: intent.subject.owner.activityPubActorUri ?? null,
        handle: intent.subject.owner.handle ?? null,
      };
    }

    base.report = {
      subjectKind: intent.subject.kind,
      authoritativeProtocol: intent.subject.authoritativeProtocol,
      reasonType: intent.reasonType,
      reason: intent.reason ?? null,
      evidence: (intent.evidenceObjectRefs ?? []).map((ref) => ({
        canonicalObjectId: ref.canonicalObjectId,
        atUri: ref.atUri ?? null,
        activityPubObjectId: ref.activityPubObjectId ?? null,
        canonicalUrl: ref.canonicalUrl ?? null,
      })),
      requestedForwardingRemote: intent.requestedForwarding?.remote ?? null,
      clientContext: intent.clientContext ?? null,
    };
  }

  // Extract mention targets for notification fan-out
  if (intent.kind === "PostCreate" || intent.kind === "PostEdit") {
    const mentionActorUris = intent.content.facets
      .filter((f): f is Extract<typeof f, { type: "mention" }> => f.type === "mention")
      .map((f) =>
        f.target.activityPubActorUri ??
        f.target.did ??
        f.target.handle ??
        null,
      )
      .filter((v): v is string => v !== null);

    if (mentionActorUris.length > 0) {
      base.mentions = [...new Set(mentionActorUris)];
    }
  }

  const content = buildContentSummary(intent);
  if (content) {
    base.content = content;
  }

  return base;
}

function resolvePartitionKey(intent: CanonicalIntent): string {
  return (
    intent.sourceAccountRef.activityPubActorUri ??
    intent.sourceAccountRef.did ??
    intent.sourceAccountRef.canonicalAccountId ??
    intent.canonicalIntentId
  );
}

function buildContentSummary(intent: CanonicalIntent): CanonicalV1Event["content"] | undefined {
  if (
    intent.kind === "PostCreate" ||
    intent.kind === "PostEdit" ||
    intent.kind === "ProfileUpdate"
  ) {
    const tags = extractTagCandidates(intent.content.facets);
    const links = extractLinkCandidates(intent.content.facets);
    const linkPreviewUrl = normalizeOptionalUrl(intent.content.linkPreview?.uri);
    const externalUrl = normalizeOptionalUrl(intent.content.externalUrl);

    return compactContentSummary({
      kind: intent.content.kind,
      title: normalizeOptionalText(intent.content.title),
      summary: truncateOptionalText(intent.content.summary, MAX_CANONICAL_CONTENT_TEXT_LENGTH),
      plaintext: truncateOptionalText(intent.content.plaintext, MAX_CANONICAL_CONTENT_TEXT_LENGTH),
      language: normalizeOptionalText(intent.content.language),
      ...(tags.length > 0 ? { tags } : {}),
      ...(links.length > 0 ? { links } : {}),
      ...(externalUrl ? { externalUrl } : {}),
      ...(linkPreviewUrl ? { linkPreviewUrl } : {}),
    });
  }

  if (intent.kind === "PollCreate" || intent.kind === "PollEdit") {
    return compactContentSummary({
      kind: "poll",
      plaintext: truncateOptionalText(intent.question, MAX_CANONICAL_CONTENT_TEXT_LENGTH),
    });
  }

  return undefined;
}

function compactContentSummary(summary: NonNullable<CanonicalV1Event["content"]>): CanonicalV1Event["content"] {
  const out: NonNullable<CanonicalV1Event["content"]> = { kind: summary.kind };
  if (summary.title) out.title = summary.title;
  if (summary.summary) out.summary = summary.summary;
  if (summary.plaintext) out.plaintext = summary.plaintext;
  if (summary.language) out.language = summary.language;
  if (summary.tags && summary.tags.length > 0) out.tags = summary.tags;
  if (summary.links && summary.links.length > 0) out.links = summary.links;
  if (summary.externalUrl) out.externalUrl = summary.externalUrl;
  if (summary.linkPreviewUrl) out.linkPreviewUrl = summary.linkPreviewUrl;
  return out;
}

function extractTagCandidates(facets: readonly CanonicalFacet[]): string[] {
  return uniqueStrings(
    facets
      .filter((facet): facet is Extract<CanonicalFacet, { type: "tag" }> => facet.type === "tag")
      .map((facet) => facet.tag.trim().replace(/^#/, ""))
      .filter((tag) => tag.length > 0),
  );
}

function extractLinkCandidates(facets: readonly CanonicalFacet[]): string[] {
  return uniqueStrings(
    facets
      .filter((facet): facet is Extract<CanonicalFacet, { type: "link" }> => facet.type === "link")
      .map((facet) => normalizeOptionalUrl(facet.url))
      .filter((url): url is string => Boolean(url)),
  );
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values])].slice(0, 50);
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function truncateOptionalText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeOptionalUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
