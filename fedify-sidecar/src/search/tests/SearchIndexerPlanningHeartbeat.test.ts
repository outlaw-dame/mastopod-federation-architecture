import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchIndexerService } from '../service/SearchIndexerService.js';

function makeCreateNote(outboxIntentId: string) {
  return {
    outboxIntentId,
    origin: 'remote',
    actorUri: 'https://remote.example/users/alice',
    receivedAt: new Date().toISOString(),
    meta: {
      searchConsent: {
        raw: [],
        isPublic: true,
        explicitlySet: true,
        source: 'actor_indexable',
        objectSearchableBy: [],
        actorSearchableBy: [],
        actorIndexable: true,
        actorIndexableExplicit: true,
      },
    },
    activity: {
      id: 'https://remote.example/users/alice/activities/1',
      type: 'Create',
      actor: 'https://remote.example/users/alice',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: 'https://remote.example/users/alice/notes/1',
        type: 'Note',
        attributedTo: 'https://remote.example/users/alice',
        content: '<p>heartbeat planning regression</p>',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
    },
  };
}

describe('SearchIndexerService OS4b planning heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('heartbeats continuously while a slow outbox completion lookup is still pending', async () => {
    vi.useFakeTimers();

    const service = createSearchIndexerService({ maxBatchSize: 100 });
    const slowHas = vi.fn(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 6_500)),
    );
    (service as any).outboxIntentDeduper = {
      has: slowHas,
      claim: vi.fn(async () => true),
    };

    const heartbeat = vi.fn(async () => undefined);
    const resolveOffset = vi.fn();
    const event = makeCreateNote('intent-slow-planning');
    const message = {
      offset: '0',
      value: Buffer.from(JSON.stringify(event)),
      headers: {},
    };
    const payload = {
      batch: {
        topic: 'ap.firehose.v1',
        partition: 0,
        messages: [message],
      },
      heartbeat,
      resolveOffset,
    };

    const planning = (service as any).processContentGroup([message], payload);

    await vi.advanceTimersByTimeAsync(3_100);
    expect(slowHas).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(resolveOffset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_500);
    await planning;

    expect(resolveOffset).toHaveBeenCalledWith('0');
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
