/**
 * SearchIndexerService — Acceptance Tests
 *
 * Tests the full pipeline from raw AP firehose event through the projector
 * and in-process bus to the OpenSearch index writer, using in-memory stubs
 * for OpenSearch and the alias cache.
 *
 * Does NOT require Kafka, Redis, or a live OpenSearch node.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ApSearchProjector } from '../projectors/ApSearchProjector.js';
import { PublicContentIndexWriter } from '../writer/PublicContentIndexWriter.js';
import { InMemoryOpenSearchClient } from '../writer/OpenSearchClient.js';
import { InMemorySearchDocAliasCache } from '../writer/SearchDocAliasCache.js';
import { DefaultSearchDedupService } from '../aliases/SearchDedupService.js';
import { SearchEventBus } from '../service/SearchEventBus.js';
import type { SearchPublicUpsertV1, SearchPublicDeleteV1 } from '../events/SearchEvents.js';
import type { IdentityAliasResolver, ResolvedIdentity } from '../identity/IdentityAliasResolver.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

class NoopIdentityResolver implements IdentityAliasResolver {
  async resolveByCanonicalId(id: string): Promise<ResolvedIdentity> { return { canonicalId: id }; }
  async resolveByApUri(uri: string): Promise<ResolvedIdentity> { return { apUri: uri }; }
  async resolveByAtDid(did: string): Promise<ResolvedIdentity> { return { atDid: did }; }
}

function buildPipeline() {
  const osClient = new InMemoryOpenSearchClient();
  const aliasCache = new InMemorySearchDocAliasCache();
  const dedupService = new DefaultSearchDedupService(aliasCache);
  const writer = new PublicContentIndexWriter(osClient, aliasCache, dedupService);
  const bus = new SearchEventBus();
  const projector = new ApSearchProjector(new NoopIdentityResolver(), bus);

  bus.on('search.public.upsert.v1', async (p) => writer.onUpsert(p as SearchPublicUpsertV1));
  bus.on('search.public.delete.v1', async (p) => writer.onDelete(p as SearchPublicDeleteV1));

  return { osClient, bus, projector };
}

/** Minimal public Create/Note firehose event */
function makeCreateNote(overrides: Record<string, unknown> = {}) {
  return {
    origin: 'local',
    actorUri: 'https://pod.example/alice',
    receivedAt: new Date().toISOString(),
    meta: {},
    activity: {
      id: 'https://pod.example/alice/activities/1',
      type: 'Create',
      actor: 'https://pod.example/alice',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [],
      published: new Date().toISOString(),
      object: {
        id: 'https://pod.example/alice/notes/1',
        type: 'Note',
        content: '<p>Hello world</p>',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [],
        published: new Date().toISOString(),
      },
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SearchEventBus', () => {
  it('routes a publish to the registered handler', async () => {
    const bus = new SearchEventBus();
    const received: unknown[] = [];
    bus.on('test.topic', async (p) => { received.push(p); });
    await bus.publish('test.topic', { id: 1 } as any);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 1 });
  });

  it('supports multiple handlers for the same topic', async () => {
    const bus = new SearchEventBus();
    let count = 0;
    bus.on('my.topic', async () => { count++; });
    bus.on('my.topic', async () => { count++; });
    await bus.publish('my.topic', {} as any);
    expect(count).toBe(2);
  });

  it('delivers nothing when no handler is registered', async () => {
    const bus = new SearchEventBus();
    await expect(bus.publish('unknown.topic', {} as any)).resolves.toBeUndefined();
  });

  it('off() removes all handlers for a topic', async () => {
    const bus = new SearchEventBus();
    let called = false;
    bus.on('x', async () => { called = true; });
    bus.off('x');
    await bus.publish('x', {} as any);
    expect(called).toBe(false);
  });
});

describe('SearchIndexerService pipeline — basic indexing', () => {
  it('indexes a public Create/Note event into OpenSearch', async () => {
    const { osClient, projector } = buildPipeline();

    await projector.onApFirehoseEvent(makeCreateNote());

    const docs = osClient.getAll();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.text).toBe('Hello world');
    expect(docs[0]!.protocolPresence).toContain('ap');
    expect(docs[0]!.sourceKind).toBe('local');
    expect(docs[0]!.isDeleted).toBe(false);
  });

  it('sets ap.objectUri on the indexed document', async () => {
    const { osClient, projector } = buildPipeline();

    await projector.onApFirehoseEvent(makeCreateNote());

    const docs = osClient.getAll();
    expect(docs[0]!.ap?.objectUri).toBe('https://pod.example/alice/notes/1');
  });

  it('sets author.apUri to the actor URI', async () => {
    const { osClient, projector } = buildPipeline();

    await projector.onApFirehoseEvent(makeCreateNote());

    const docs = osClient.getAll();
    expect(docs[0]!.author.apUri).toBe('https://pod.example/alice');
  });

  it('does NOT index non-public activities (no Public in to/cc)', async () => {
    const { osClient, projector } = buildPipeline();

    const event = makeCreateNote();
    event.activity.to = ['https://pod.example/bob'];
    (event.activity.object as any).to = ['https://pod.example/bob'];

    await projector.onApFirehoseEvent(event);

    expect(osClient.getAll()).toHaveLength(0);
  });

  it('does NOT index non-Create activity types (e.g. Announce)', async () => {
    const { osClient, projector } = buildPipeline();

    const event = makeCreateNote();
    (event.activity as any).type = 'Announce';

    await projector.onApFirehoseEvent(event);

    expect(osClient.getAll()).toHaveLength(0);
  });

  it('does NOT index Create activities with non-Note object types', async () => {
    const { osClient, projector } = buildPipeline();

    const event = makeCreateNote();
    (event.activity.object as any).type = 'Image';

    await projector.onApFirehoseEvent(event);

    expect(osClient.getAll()).toHaveLength(0);
  });

  it('strips HTML tags from Note content for the indexed text field', async () => {
    const { osClient, projector } = buildPipeline();

    const event = makeCreateNote();
    (event.activity.object as any).content = '<p>Check out <a href="...">this link</a>!</p>';

    await projector.onApFirehoseEvent(event);

    const docs = osClient.getAll();
    expect(docs[0]!.text).toBe('Check out this link!');
  });

  it('deduplicates two indexing events for the same object URI', async () => {
    const { osClient, projector } = buildPipeline();

    await projector.onApFirehoseEvent(makeCreateNote());
    await projector.onApFirehoseEvent(makeCreateNote());

    // Same stableDocId → single doc (upsert semantics)
    expect(osClient.getAll()).toHaveLength(1);
  });
});

describe('SearchIndexerService pipeline — FEP-268d consent gate', () => {
  /**
   * The consumer-level gate in SearchIndexerService.processBatch() skips events
   * before they reach the projector.  We simulate the same logic here.
   */
  function applyConsumerConsentGate(
    event: ReturnType<typeof makeCreateNote>,
  ): boolean {
    const consent = (event.meta as any)?.searchConsent;
    if (consent?.explicitlySet === true && consent?.isPublic === false) {
      return false; // blocked
    }
    return true;
  }

  it('passes through events with no explicit consent signal (liberal default)', () => {
    const event = makeCreateNote();
    expect(applyConsumerConsentGate(event)).toBe(true);
  });

  it('passes through events where searchableBy is explicitly Public', () => {
    const event = makeCreateNote({ meta: { searchConsent: { explicitlySet: true, isPublic: true } } });
    expect(applyConsumerConsentGate(event)).toBe(true);
  });

  it('blocks events where actor has explicitly opted out of search (FEP-268d)', () => {
    const event = makeCreateNote({ meta: { searchConsent: { explicitlySet: true, isPublic: false } } });
    expect(applyConsumerConsentGate(event)).toBe(false);
  });

  it('does not index a consented-no event end-to-end', async () => {
    const { osClient, projector } = buildPipeline();

    const event = makeCreateNote({ meta: { searchConsent: { explicitlySet: true, isPublic: false } } });

    // Gate fires before calling projector — simulate full pipeline
    if (applyConsumerConsentGate(event)) {
      await projector.onApFirehoseEvent(event);
    }

    expect(osClient.getAll()).toHaveLength(0);
  });
});

describe('SearchIndexerService pipeline — tombstone / delete', () => {
  it('marks an existing document as deleted on AP tombstone', async () => {
    const { osClient, projector } = buildPipeline();

    // First index the document
    await projector.onApFirehoseEvent(makeCreateNote());
    expect(osClient.getAll()).toHaveLength(1);

    // Then tombstone it
    await projector.onApTombstoneEvent({
      objectId: 'https://pod.example/alice/notes/1',
      origin: 'local',
    });

    const docs = osClient.getAll();
    // The writer's onDelete with deleteMode 'soft' sets isDeleted = true
    expect(docs[0]!.isDeleted).toBe(true);
  });
});

describe('SearchEventBus — publishBatch', () => {
  it('delivers all events in order', async () => {
    const bus = new SearchEventBus();
    const received: number[] = [];
    bus.on('seq', async (p: any) => { received.push(p.n); });

    await bus.publishBatch([
      { topic: 'seq', event: { n: 1 } as any },
      { topic: 'seq', event: { n: 2 } as any },
      { topic: 'seq', event: { n: 3 } as any },
    ]);

    expect(received).toEqual([1, 2, 3]);
  });
});
