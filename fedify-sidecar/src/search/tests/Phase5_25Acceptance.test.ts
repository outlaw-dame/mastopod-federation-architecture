/// <reference types="vitest/globals" />
/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * Acceptance Tests
 */

import { ApSearchProjector } from '../projectors/ApSearchProjector.js';
import { AtSearchProjector } from '../projectors/AtSearchProjector.js';
import { PublicContentIndexWriter } from '../writer/PublicContentIndexWriter.js';
import { InMemoryOpenSearchClient } from '../writer/OpenSearchClient.js';
import { InMemorySearchDocAliasCache } from '../writer/SearchDocAliasCache.js';
import { DefaultSearchDedupService } from '../aliases/SearchDedupService.js';
import { IdentityAliasResolver, ResolvedIdentity } from '../identity/IdentityAliasResolver.js';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';
import { SearchPublicUpsertV1, SearchPublicDeleteV1 } from '../events/SearchEvents.js';

// Mock Identity Resolver
class MockIdentityResolver implements IdentityAliasResolver {
  async resolveByCanonicalId(canonicalId: string): Promise<ResolvedIdentity> {
    return {
      canonicalId,
      apUri: `https://ap.example.com/users/${canonicalId}`,
      atDid: `did:plc:${canonicalId}`,
      atHandle: `${canonicalId}.bsky.social`
    };
  }

  async resolveByApUri(apUri: string): Promise<ResolvedIdentity> {
    const id = apUri.split('/').pop() || 'unknown';
    return this.resolveByCanonicalId(id);
  }

  async resolveByAtDid(did: string): Promise<ResolvedIdentity> {
    const id = did.split(':').pop() || 'unknown';
    return this.resolveByCanonicalId(id);
  }
}

// Mock Event Publisher that routes directly to IndexWriter
class DirectEventPublisher implements EventPublisher {
  constructor(private readonly writer: PublicContentIndexWriter) {}

  async publish(topic: string, event: any): Promise<void> {
    if (topic === 'search.public.upsert.v1') {
      await this.writer.onUpsert(event as SearchPublicUpsertV1);
    } else if (topic === 'search.public.delete.v1') {
      await this.writer.onDelete(event as SearchPublicDeleteV1);
    }
  }

  async publishBatch(events: any[]): Promise<void> {
    for (const { topic, event } of events) {
      await this.publish(topic, event);
    }
  }
}

describe('Phase 5.25 Acceptance Tests', () => {
  let osClient: InMemoryOpenSearchClient;
  let aliasCache: InMemorySearchDocAliasCache;
  let writer: PublicContentIndexWriter;
  let dedupService: DefaultSearchDedupService;
  let publisher: DirectEventPublisher;
  let identityResolver: MockIdentityResolver;
  let apProjector: ApSearchProjector;
  let atProjector: AtSearchProjector;

  beforeEach(() => {
    osClient = new InMemoryOpenSearchClient();
    aliasCache = new InMemorySearchDocAliasCache();
    dedupService = new DefaultSearchDedupService(aliasCache);
    writer = new PublicContentIndexWriter(osClient, aliasCache, dedupService);
    publisher = new DirectEventPublisher(writer);
    identityResolver = new MockIdentityResolver();
    apProjector = new ApSearchProjector(identityResolver, publisher);
    atProjector = new AtSearchProjector(identityResolver, publisher);
  });

  it('Test 1 — local dual-protocol dedup', async () => {
    // AP Event
    await apProjector.onApFirehoseEvent({
      origin: 'local',
      activity: {
        type: 'Create',
        actor: 'https://ap.example.com/users/user1',
        object: {
          type: 'Note',
          id: 'post1',
          content: 'Hello world',
          to: ['as:Public']
        }
      }
    });

    // AT Event
    await atProjector.onAtCommitEvent({
      did: 'did:plc:user1',
      canonicalAccountId: 'user1',
      rev: 'rev1',
      commitCid: 'cid1',
      prevCommitCid: null,
      repoVersion: 3,
      ops: [{
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post1',
        canonicalRefId: 'post1',
        record: {
          text: 'Hello world',
          createdAt: new Date().toISOString()
        }
      } as any],
      emittedAt: new Date().toISOString()
    }, 'local');

    const docs = osClient.getAll();
    expect(docs.length).toBe(1);
    
    const doc = docs[0]!;
    expect(doc.stableDocId).toBe('post1');
    expect(doc.protocolPresence).toContain('ap');
    expect(doc.protocolPresence).toContain('at');
    expect(doc.ap?.objectUri).toBe('post1');
    expect(doc.at?.uri).toBe('at://did:plc:user1/app.bsky.feed.post/post1');
  });

  it('Test 2 — AT-only local content', async () => {
    await atProjector.onAtCommitEvent({
      did: 'did:plc:user1',
      canonicalAccountId: 'user1',
      rev: 'rev1',
      commitCid: 'cid1',
      prevCommitCid: null,
      repoVersion: 3,
      ops: [{
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post2',
        canonicalRefId: 'post2',
        record: {
          text: 'AT only',
          createdAt: new Date().toISOString()
        }
      } as any],
      emittedAt: new Date().toISOString()
    }, 'local');

    const docs = osClient.getAll();
    expect(docs.length).toBe(1);
    
    const doc = docs[0]!;
    expect(doc.stableDocId).toBe('post2');
    expect(doc.protocolPresence).toEqual(['at']);
    expect(doc.ap).toBeUndefined();
  });

  it('Test 3 — remote AT ingestion', async () => {
    await atProjector.onAtCommitEvent({
      did: 'did:plc:remote1',
      canonicalAccountId: 'remote1',
      rev: 'rev1',
      commitCid: 'cid1',
      prevCommitCid: null,
      repoVersion: 3,
      ops: [{
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post3',
        record: {
          text: 'Remote AT',
          createdAt: new Date().toISOString()
        }
      } as any],
      emittedAt: new Date().toISOString()
    }, 'remote');

    const docs = osClient.getAll();
    expect(docs.length).toBe(1);
    
    const doc = docs[0]!;
    expect(doc.sourceKind).toBe('remote');
    expect(doc.stableDocId).toBe('at:at://did:plc:remote1/app.bsky.feed.post/post3');
  });

  it('Test 4 — delete propagation', async () => {
    // Create first
    await atProjector.onAtCommitEvent({
      did: 'did:plc:user1',
      canonicalAccountId: 'user1',
      rev: 'rev1',
      commitCid: 'cid1',
      prevCommitCid: null,
      repoVersion: 3,
      ops: [{
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post4',
        canonicalRefId: 'post4',
        record: {
          text: 'To be deleted',
          createdAt: new Date().toISOString()
        }
      } as any],
      emittedAt: new Date().toISOString()
    }, 'local');

    // Delete
    await atProjector.onAtCommitEvent({
      did: 'did:plc:user1',
      canonicalAccountId: 'user1',
      rev: 'rev2',
      commitCid: 'cid2',
      prevCommitCid: 'cid1',
      repoVersion: 3,
      ops: [{
        action: 'delete',
        collection: 'app.bsky.feed.post',
        rkey: 'post4',
        canonicalRefId: 'post4'
      } as any],
      emittedAt: new Date().toISOString()
    }, 'local');

    const doc = await osClient.get('post4');
    expect(doc).toBeDefined();
    expect(doc?.isDeleted).toBe(true);
  });

  it('Test 5 — enrichment', async () => {
    // AP arrives first
    await apProjector.onApFirehoseEvent({
      origin: 'local',
      activity: {
        type: 'Create',
        actor: 'https://ap.example.com/users/user1',
        object: {
          type: 'Note',
          id: 'post5',
          content: 'Enrich me',
          to: ['as:Public']
        }
      }
    });

    let docs = osClient.getAll();
    expect(docs.length).toBe(1);
    expect(docs[0]!.protocolPresence).toEqual(['ap']);

    // AT arrives later
    await atProjector.onAtCommitEvent({
      did: 'did:plc:user1',
      canonicalAccountId: 'user1',
      rev: 'rev1',
      commitCid: 'cid1',
      prevCommitCid: null,
      repoVersion: 3,
      ops: [{
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post5',
        canonicalRefId: 'post5',
        record: {
          text: 'Enrich me',
          createdAt: new Date().toISOString()
        }
      } as any],
      emittedAt: new Date().toISOString()
    }, 'local');

    docs = osClient.getAll();
    expect(docs.length).toBe(1); // Still 1 document
    expect(docs[0]!.protocolPresence).toContain('ap');
    expect(docs[0]!.protocolPresence).toContain('at');
  });

  it('Test 6 — remote duplicate safety', async () => {
    // Remote AP
    await apProjector.onApFirehoseEvent({
      origin: 'remote',
      activity: {
        type: 'Create',
        actor: 'https://ap.example.com/users/remote2',
        object: {
          type: 'Note',
          id: 'https://ap.example.com/posts/post6',
          content: 'Remote content',
          to: ['as:Public']
        }
      }
    });

    // Remote AT (same content, but no strong linkage in our mock)
    await atProjector.onAtCommitEvent({
      did: 'did:plc:remote2',
      canonicalAccountId: 'remote2',
      rev: 'rev1',
      commitCid: 'cid1',
      prevCommitCid: null,
      repoVersion: 3,
      ops: [{
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post6',
        record: {
          text: 'Remote content',
          createdAt: new Date().toISOString()
        }
      } as any],
      emittedAt: new Date().toISOString()
    }, 'remote');

    const docs = osClient.getAll();
    // Because they are remote and we don't have a canonical ID linking them
    // in the event payload (canonicalRefId is undefined for remote),
    // they should be kept separate.
    expect(docs.length).toBe(2);
    expect(docs.map(d => d.stableDocId)).toContain('ap:https://ap.example.com/posts/post6');
    expect(docs.map(d => d.stableDocId)).toContain('at:at://did:plc:remote2/app.bsky.feed.post/post6');
  });

  it('Test 7 — AT quote posts with recordWithMedia retain quote relation and media count', async () => {
    await atProjector.onAtCommitEvent({
      did: 'did:plc:remote3',
      canonicalAccountId: 'remote3',
      rev: 'rev1',
      commitCid: 'cid1',
      prevCommitCid: null,
      repoVersion: 3,
      ops: [{
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post7',
        record: {
          text: 'Quoted post with media',
          createdAt: new Date().toISOString(),
          embed: {
            $type: 'app.bsky.embed.recordWithMedia',
            record: {
              uri: 'at://did:plc:quoted/app.bsky.feed.post/3kquoted',
              cid: 'bafy-quoted'
            },
            media: {
              $type: 'app.bsky.embed.images',
              images: [
                {
                  alt: 'Quote image',
                  image: {
                    $type: 'blob',
                    ref: { $link: 'bafy-image-1' },
                    mimeType: 'image/png',
                    size: 2048
                  }
                }
              ]
            }
          }
        }
      } as any],
      emittedAt: new Date().toISOString()
    }, 'remote');

    const docs = osClient.getAll();
    expect(docs.length).toBe(1);

    const doc = docs[0]!;
    expect(doc.quoteOfStableId).toBe('at:at://did:plc:quoted/app.bsky.feed.post/3kquoted');
    expect(doc.hasMedia).toBe(true);
    expect(doc.mediaCount).toBe(1);
  });

  it('Test 8 — AP quote posts with media retain quote relation and media count', async () => {
    await apProjector.onApFirehoseEvent({
      origin: 'remote',
      activity: {
        type: 'Create',
        actor: 'https://ap.example.com/users/remote4',
        object: {
          type: 'Note',
          id: 'https://ap.example.com/posts/post8',
          content: 'Quoted AP content',
          to: ['as:Public'],
          quoteUrl: 'https://remote.example/posts/quoted-ap',
          attachment: [
            {
              type: 'Image',
              mediaType: 'image/jpeg',
              url: 'https://cdn.remote.example/quote-ap.jpg'
            }
          ]
        }
      }
    });

    const docs = osClient.getAll();
    expect(docs.length).toBe(1);

    const doc = docs[0]!;
    expect(doc.quoteOfStableId).toBe('ap:https://remote.example/posts/quoted-ap');
    expect(doc.hasMedia).toBe(true);
    expect(doc.mediaCount).toBe(1);
  });
});
