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
import type { CanonicalV1Event, CanonicalV1ActorRef, CanonicalV1ObjectRef } from "../../streams/v6-topology.js";

export const CANONICAL_V1_TOPIC = "canonical.v1";

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

function serializeIntent(intent: CanonicalIntent): CanonicalV1Event {
  const actor: CanonicalV1ActorRef = {
    canonicalAccountId: intent.sourceAccountRef.canonicalAccountId ?? null,
    did: intent.sourceAccountRef.did ?? null,
    activityPubActorUri: intent.sourceAccountRef.activityPubActorUri ?? null,
    handle: intent.sourceAccountRef.handle ?? null,
  };

  const base: CanonicalV1Event = {
    canonicalIntentId: intent.canonicalIntentId,
    kind: intent.kind,
    sourceProtocol: intent.sourceProtocol,
    sourceEventId: intent.sourceEventId,
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
    intent.kind === "ReactionAdd" ||
    intent.kind === "ReactionRemove" ||
    intent.kind === "ShareAdd" ||
    intent.kind === "ShareRemove"
  ) {
    const obj = intent.object;
    const objectRef: CanonicalV1ObjectRef = {
      canonicalObjectId: obj.canonicalObjectId,
      atUri: obj.atUri ?? null,
      activityPubObjectId: obj.activityPubObjectId ?? null,
      canonicalUrl: obj.canonicalUrl ?? null,
    };
    base.object = objectRef;
  }

  // Attach subject ref for follow actions
  if (intent.kind === "FollowAdd" || intent.kind === "FollowRemove") {
    base.subject = {
      canonicalAccountId: intent.subject.canonicalAccountId ?? null,
      did: intent.subject.did ?? null,
      activityPubActorUri: intent.subject.activityPubActorUri ?? null,
      handle: intent.subject.handle ?? null,
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
