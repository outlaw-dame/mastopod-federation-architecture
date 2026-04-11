/**
 * SearchEventBus — In-process typed event bus for the search indexing pipeline.
 *
 * Decouples ApSearchProjector / AtSearchProjector from PublicContentIndexWriter
 * without routing through a Redpanda topic.  The bus accepts any payload (the
 * projectors already cast their typed events `as any` when calling
 * EventPublisher.publish()).
 */

import type { EventPublisher, EventMetadata, CoreIdentityEvent } from '../../core-domain/events/CoreIdentityEvents.js';

type TopicHandler = (payload: unknown) => Promise<void>;

export class SearchEventBus implements EventPublisher {
  private handlers = new Map<string, TopicHandler[]>();

  /**
   * Subscribe to a named topic.  Multiple handlers per topic are supported.
   */
  on(topic: string, handler: TopicHandler): void {
    let list = this.handlers.get(topic);
    if (!list) {
      list = [];
      this.handlers.set(topic, list);
    }
    list.push(handler);
  }

  /**
   * Remove all handlers for a topic.
   */
  off(topic: string): void {
    this.handlers.delete(topic);
  }

  // ── EventPublisher contract ──────────────────────────────────────────────

  async publish<T extends CoreIdentityEvent>(
    topic: string,
    event: T,
    _metadata?: Partial<EventMetadata>,
  ): Promise<void> {
    const list = this.handlers.get(topic);
    if (!list || list.length === 0) return;
    for (const handler of list) {
      await handler(event as unknown);
    }
  }

  async publishBatch(
    events: Array<{
      topic: string;
      event: CoreIdentityEvent;
      metadata?: Partial<EventMetadata>;
    }>,
  ): Promise<void> {
    for (const { topic, event, metadata } of events) {
      await this.publish(topic, event, metadata);
    }
  }
}
