import type { EventPublisher, EventMetadata, CoreIdentityEvent } from '../../core-domain/events/CoreIdentityEvents.js';
import type { IdentityAliasResolver } from '../identity/IdentityAliasResolver.js';
import { ApSearchProjector } from '../projectors/ApSearchProjector.js';

export interface CollectedSearchEvent {
  topic: string;
  event: unknown;
}

class CollectingPublisher implements EventPublisher {
  readonly events: CollectedSearchEvent[] = [];

  async publish<T extends CoreIdentityEvent>(
    topic: string,
    event: T,
    _metadata?: Partial<EventMetadata>,
  ): Promise<void> {
    this.events.push({ topic, event });
  }

  async publishBatch(
    events: Array<{ topic: string; event: CoreIdentityEvent; metadata?: Partial<EventMetadata> }>,
  ): Promise<void> {
    for (const item of events) this.events.push({ topic: item.topic, event: item.event });
  }
}

/**
 * Reuses the authoritative AP projector while capturing its output before any
 * Tier-3 side effect. OS4b uses this only to form safe content-upsert batches;
 * actor/delete/multi-event projections stay on the original ordered path.
 */
export async function collectApFirehoseEvents(
  identityResolver: IdentityAliasResolver,
  sourceEvent: unknown,
): Promise<CollectedSearchEvent[]> {
  const collector = new CollectingPublisher();
  const projector = new ApSearchProjector(identityResolver, collector);
  await projector.onApFirehoseEvent(sourceEvent as any);
  return collector.events;
}
