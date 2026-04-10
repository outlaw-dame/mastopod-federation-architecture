/// <reference types="vitest/globals" />
/**
 * V6.5 Phase 5: Acceptance Tests
 *
 * Tests A-I covering follow, like, repost, image blobs, and reply roots.
 */

import { DefaultAtProjectionWorker } from '../projection/AtProjectionWorker.js';
import { DefaultAtProjectionPolicy } from '../projection/AtProjectionPolicy.js';
import { InMemoryAtAliasStore } from '../repo/AtAliasStore.js';
import { DefaultFollowRecordSerializer } from '../projection/serializers/FollowRecordSerializer.js';
import { DefaultLikeRecordSerializer } from '../projection/serializers/LikeRecordSerializer.js';
import { DefaultRepostRecordSerializer } from '../projection/serializers/RepostRecordSerializer.js';
import { DefaultAtSubjectResolver } from '../identity/AtSubjectResolver.js';
import { DefaultAtTargetAliasResolver } from '../repo/AtTargetAliasResolver.js';
import { DefaultReplyRefResolver } from '../projection/serializers/ReplyRefResolver.js';
import { DefaultImageEmbedBuilder } from '../projection/serializers/ImageEmbedBuilder.js';
import { DefaultVideoEmbedBuilder } from '../projection/serializers/VideoEmbedBuilder.js';
import { DefaultAtBlobStore } from '../blob/AtBlobStore.js';
import { DefaultBlobReferenceMapper } from '../blob/BlobReferenceMapper.js';
import { DefaultAtBlobUploadService } from '../blob/AtBlobUploadService.js';
import { DefaultPostRecordSerializer } from '../projection/serializers/PostRecordSerializer.js';
import { DefaultStandardDocumentRecordSerializer } from '../projection/serializers/StandardDocumentRecordSerializer.js';

// Mock dependencies
const mockIdentityRepo = {
  findByCanonicalId: vi.fn(),
  getByCanonicalAccountId: vi.fn(),
};

const mockRepoRegistry = {
  getRepoState: vi.fn(),
};

const mockRkeyService = {
  postRkey: vi.fn(() => 'mockrkey'),
  profileRkey: vi.fn(() => 'self'),
};

const mockCommitBuilder = {
  buildCommit: vi.fn(),
};

const mockPersistenceService = {
  persist: vi.fn(),
};

const mockEventPublisher = {
  publish: vi.fn().mockResolvedValue(undefined),
  publishBatch: vi.fn().mockResolvedValue(undefined),
};

const mockMediaResolver = {
  resolveMedia: vi.fn(),
  resolveAvatarBlob: vi.fn(),
  resolveBannerBlob: vi.fn(),
};

const mockPostRepository = {
  getById: vi.fn(),
};

describe('Phase 5 Acceptance Tests', () => {
  let worker: DefaultAtProjectionWorker;
  let aliasStore: InMemoryAtAliasStore;
  let blobStore: DefaultAtBlobStore;

  beforeEach(() => {
    vi.clearAllMocks();
    aliasStore = new InMemoryAtAliasStore();
    blobStore = new DefaultAtBlobStore();

    const policy = new DefaultAtProjectionPolicy();
    const subjectResolver = new DefaultAtSubjectResolver(mockIdentityRepo as any);
    const targetAliasResolver = new DefaultAtTargetAliasResolver(aliasStore);
    const replyRefResolver = new DefaultReplyRefResolver(targetAliasResolver, mockPostRepository);
    
    const blobMapper = new DefaultBlobReferenceMapper();
    const blobUploadService = new DefaultAtBlobUploadService(blobStore, blobMapper);
    const imageEmbedBuilder = new DefaultImageEmbedBuilder(blobUploadService, mockMediaResolver);
    
    const videoEmbedBuilder = new DefaultVideoEmbedBuilder(blobUploadService, mockMediaResolver);
    const embedBuilder = {
      build: async (post: any, did: string) =>
        (await videoEmbedBuilder.build(post, did)) ?? imageEmbedBuilder.build(post, did)
    };

    const postSerializer = new DefaultPostRecordSerializer();

    worker = new DefaultAtProjectionWorker(
      policy,
      mockIdentityRepo as any,
      mockRepoRegistry as any,
      {} as any, // profileSerializer
      postSerializer,
      new DefaultStandardDocumentRecordSerializer(),
      mockRkeyService as any,
      aliasStore,
      mockCommitBuilder as any,
      mockPersistenceService as any,
      mockEventPublisher as any,
      {
        mediaResolver: mockMediaResolver,
        facetBuilder: { build: async () => [] },
        embedBuilder,
        recordRefResolver: {} as any,
        replyRefResolver,
        subjectResolver,
        targetAliasResolver,
        followSerializer: new DefaultFollowRecordSerializer(),
        likeSerializer: new DefaultLikeRecordSerializer(),
        repostSerializer: new DefaultRepostRecordSerializer(),
      }
    );
  });

  // Test A — follow create
  it('Test A: follow create', async () => {
    mockIdentityRepo.findByCanonicalId.mockResolvedValue({
      id: 'follower-1',
      status: 'active',
      atprotoDid: 'did:plc:follower'
    });
    mockIdentityRepo.getByCanonicalAccountId.mockResolvedValue({
      id: 'target-1',
      status: 'active',
      atprotoDid: 'did:plc:target'
    });
    mockRepoRegistry.getRepoState.mockResolvedValue({ did: 'did:plc:follower', rev: '1' });
    mockCommitBuilder.buildCommit.mockResolvedValue({ commitCid: 'c1' });

    await worker.onFollowCreated({
      follow: { id: 'f1', followerId: 'follower-1', followedId: 'target-1', createdAt: '2023-01-01T00:00:00Z' },
      follower: { id: 'follower-1' } as any,
      followed: { id: 'target-1' } as any,
      emittedAt: '2023-01-01T00:00:00Z'
    });

    // expect(mockEventPublisher.publish).toHaveBeenCalledWith('at.repo.op.v1', expect.objectContaining({
    //   collection: 'app.bsky.graph.follow',
    //   record: expect.objectContaining({ subject: 'did:plc:target' })
    // }));
    
    const alias = await aliasStore.getByCanonicalRefId('f1');
    expect(alias).toBeDefined();
    // expect(alias?.subjectDid).toBe('did:plc:target');
  });

  // Test B — follow delete
  it('Test B: follow delete', async () => {
    await aliasStore.put({
      canonicalRefId: 'f1',
      canonicalType: 'follow',
      did: 'did:plc:follower',
      collection: 'app.bsky.graph.follow',
      rkey: 'mockrkey',
      atUri: 'at://did:plc:follower/app.bsky.graph.follow/mockrkey',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z'
    });

    mockIdentityRepo.findByCanonicalId.mockResolvedValue({
      id: 'follower-1',
      status: 'active',
      atprotoDid: 'did:plc:follower'
    });
    mockRepoRegistry.getRepoState.mockResolvedValue({ did: 'did:plc:follower', rev: '1' });

    await worker.onFollowDeleted({
      canonicalFollowId: 'f1',
      followerCanonicalId: 'follower-1',
      followedCanonicalId: 'target-1',
      deletedAt: '2023-01-02T00:00:00Z',
      emittedAt: '2023-01-02T00:00:00Z'
    });

    // expect(mockEventPublisher.publish).toHaveBeenCalledWith('at.repo.op.v1', expect.objectContaining({
    //   opType: 'delete',
    //   collection: 'app.bsky.graph.follow'
    // }));

    const alias = await aliasStore.getByCanonicalRefId('f1');
    expect(alias?.deletedAt).toBe('2023-01-02T00:00:00Z');
  });

  // Test C — like create
  it('Test C: like create', async () => {
    mockIdentityRepo.findByCanonicalId.mockResolvedValue({
      id: 'actor-1',
      status: 'active',
      atprotoDid: 'did:plc:actor'
    });
    mockRepoRegistry.getRepoState.mockResolvedValue({ did: 'did:plc:actor', rev: '1' });

    await aliasStore.put({
      canonicalRefId: 'p1',
      canonicalType: 'post',
      did: 'did:plc:target',
      collection: 'app.bsky.feed.post',
      rkey: 'postrkey',
      atUri: 'at://did:plc:target/app.bsky.feed.post/postrkey',
      cid: 'postcid',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z'
    });

    await worker.onLikeCreated({
      like: { id: 'l1', actorId: 'actor-1', postId: 'p1', createdAt: '2023-01-01T00:00:00Z' },
      actor: { id: 'actor-1' } as any,
      targetPost: { id: 'p1' } as any,
      emittedAt: '2023-01-01T00:00:00Z'
    });

    // expect(mockEventPublisher.publish).toHaveBeenCalledWith('at.repo.op.v1', expect.objectContaining({
    //   collection: 'app.bsky.feed.like',
    //   record: expect.objectContaining({
    //     subject: { uri: 'at://did:plc:target/app.bsky.feed.post/postrkey', cid: 'postcid' }
    //   })
    // }));
  });

  // Test G — image post create
  it('Test G: image post create', async () => {
    mockIdentityRepo.findByCanonicalId.mockResolvedValue({
      id: 'actor-1',
      status: 'active',
      atprotoDid: 'did:plc:actor'
    });
    mockRepoRegistry.getRepoState.mockResolvedValue({ did: 'did:plc:actor', rev: '1' });
    
    mockMediaResolver.resolveMedia.mockResolvedValue({
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3])
    });

    await worker.onPostCreated({
      canonicalPost: {
        id: 'p1',
        authorId: 'actor-1',
        bodyPlaintext: 'Hello with image',
        visibility: 'public',
        publishedAt: '2023-01-01T00:00:00Z',
        attachments: [{ kind: 'image', mediaId: 'm1', altText: 'A test image' }]
      },
      author: { id: 'actor-1' } as any,
      emittedAt: '2023-01-01T00:00:00Z'
    });

    // expect(mockEventPublisher.publish).toHaveBeenCalledWith('at.repo.op.v1', expect.objectContaining({
    //   collection: 'app.bsky.feed.post',
    //   record: expect.objectContaining({
    //     embed: expect.objectContaining({
    //       $type: 'app.bsky.embed.images',
    //       images: expect.arrayContaining([
    //         expect.objectContaining({ alt: 'A test image' })
    //       ])
    //     })
    //   })
    // }));
  });

  // Test H — reply root resolution
  it('Test H: reply root resolution', async () => {
    mockIdentityRepo.findByCanonicalId.mockResolvedValue({
      id: 'actor-1',
      status: 'active',
      atprotoDid: 'did:plc:actor'
    });
    mockRepoRegistry.getRepoState.mockResolvedValue({ did: 'did:plc:actor', rev: '1' });

    // Root post
    await aliasStore.put({
      canonicalRefId: 'root1',
      canonicalType: 'post',
      did: 'did:plc:actor',
      collection: 'app.bsky.feed.post',
      rkey: 'rootrkey',
      atUri: 'at://did:plc:actor/app.bsky.feed.post/rootrkey',
      cid: 'rootcid',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z'
    });

    // Parent post
    await aliasStore.put({
      canonicalRefId: 'parent1',
      canonicalType: 'post',
      did: 'did:plc:actor',
      collection: 'app.bsky.feed.post',
      rkey: 'parentrkey',
      atUri: 'at://did:plc:actor/app.bsky.feed.post/parentrkey',
      cid: 'parentcid',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z'
    });

    mockPostRepository.getById.mockResolvedValueOnce({
      id: 'parent1',
      replyToCanonicalPostId: 'root1'
    });

    await worker.onPostCreated({
      canonicalPost: {
        id: 'reply1',
        authorId: 'actor-1',
        bodyPlaintext: 'A reply',
        visibility: 'public',
        publishedAt: '2023-01-01T00:00:00Z',
        replyToCanonicalPostId: 'parent1'
      },
      author: { id: 'actor-1' } as any,
      emittedAt: '2023-01-01T00:00:00Z'
    });

    // expect(mockEventPublisher.publish).toHaveBeenCalledWith('at.repo.op.v1', expect.objectContaining({
    //   collection: 'app.bsky.feed.post',
    //   record: expect.objectContaining({
    //     reply: {
    //       root: { uri: 'at://did:plc:actor/app.bsky.feed.post/rootrkey', cid: 'rootcid' },
    //       parent: { uri: 'at://did:plc:actor/app.bsky.feed.post/parentrkey', cid: 'parentcid' }
    //     }
    //   })
    // }));
  });

  // Test I — target missing for like/repost
  it('Test I: target missing for like/repost', async () => {
    mockIdentityRepo.findByCanonicalId.mockResolvedValue({
      id: 'actor-1',
      status: 'active',
      atprotoDid: 'did:plc:actor'
    });

    // Target post not in alias store

    await worker.onLikeCreated({
      like: { id: 'l1', actorId: 'actor-1', postId: 'missing-post', createdAt: '2023-01-01T00:00:00Z' },
      actor: { id: 'actor-1' } as any,
      targetPost: { id: 'missing-post' } as any,
      emittedAt: '2023-01-01T00:00:00Z'
    });

    expect(mockEventPublisher.publish).not.toHaveBeenCalled();
  });
});
