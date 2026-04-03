/**
 * V6.5 Phase 7: End-to-End Write Proof
 *
 * Proves the full canonical write path end-to-end without requiring
 * ActivityPods, a real Signing API, or a running Redis:
 *
 *   1. Seed IdentityBinding + RepositoryState in in-memory stores
 *   2. Boot Fastify with all XRPC routes (full DI chain, mocked externals)
 *   3. POST /xrpc/com.atproto.server.createSession  → get accessJwt
 *   4. POST /xrpc/com.atproto.repo.createRecord      → app.bsky.feed.post
 *   5. Assert response contains { uri: "at://...", cid: "..." }
 *
 * Usage:
 *   npx tsx src/at-adapter/tests/Phase7WriteProof.ts
 */

import Fastify from 'fastify';
import { registerAtXrpcRoutes, attachSubscribeReposWebSocket } from '../xrpc/AtXrpcFastifyBridge.js';
import { DefaultAtXrpcServer } from '../xrpc/AtXrpcServer.js';

// Auth
import { DefaultAtSessionTokenService } from '../auth/DefaultAtSessionTokenService.js';
import { DefaultAtAccountResolver } from '../auth/DefaultAtAccountResolver.js';
import { DefaultAtSessionService } from '../auth/DefaultAtSessionService.js';
import type { AtPasswordVerifier } from '../auth/AtSessionTypes.js';

// Repo / alias
import { InMemoryAtAliasStore } from '../repo/AtAliasStore.js';
import { InMemoryAtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry.js';
import { DefaultAtRecordReader } from '../repo/AtRecordReader.js';
import { DefaultAtCarExporter } from '../repo/AtCarExporter.js';
import { DefaultAtRkeyService } from '../repo/AtRkeyService.js';
import { DefaultAtRecordRefResolver } from '../repo/AtRecordRefResolver.js';
import { DefaultAtTargetAliasResolver } from '../repo/AtTargetAliasResolver.js';
import { DefaultAtCommitBuilder } from '../repo/AtCommitBuilder.js';
import { DefaultAtCommitPersistenceService } from '../repo/AtCommitPersistenceService.js';

// Identity
import { DefaultHandleResolutionReader } from '../identity/HandleResolutionReader.js';
import { DefaultAtSubjectResolver } from '../identity/AtSubjectResolver.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';

// Firehose
import { DefaultAtFirehoseSubscriptionManager } from '../firehose/AtFirehoseSubscriptionManager.js';
import { InMemoryAtFirehoseCursorStore } from '../firehose/AtFirehoseCursorStore.js';

// Projection
import { DefaultAtProjectionPolicy } from '../projection/AtProjectionPolicy.js';
import { DefaultAtProjectionWorker } from '../projection/AtProjectionWorker.js';
import { DefaultProfileRecordSerializer } from '../projection/serializers/ProfileRecordSerializer.js';
import { DefaultPostRecordSerializer } from '../projection/serializers/PostRecordSerializer.js';
import { DefaultFacetBuilder } from '../projection/serializers/FacetBuilder.js';
import { DefaultEmbedBuilder } from '../projection/serializers/EmbedBuilder.js';
import { DefaultImageEmbedBuilder } from '../projection/serializers/ImageEmbedBuilder.js';
import { DefaultVideoEmbedBuilder } from '../projection/serializers/VideoEmbedBuilder.js';
import { DefaultFollowRecordSerializer } from '../projection/serializers/FollowRecordSerializer.js';
import { DefaultLikeRecordSerializer } from '../projection/serializers/LikeRecordSerializer.js';
import { DefaultRepostRecordSerializer } from '../projection/serializers/RepostRecordSerializer.js';
import { DefaultStandardDocumentRecordSerializer } from '../projection/serializers/StandardDocumentRecordSerializer.js';
import { DefaultAtBlobStore } from '../blob/AtBlobStore.js';
import { DefaultBlobReferenceMapper } from '../blob/BlobReferenceMapper.js';
import { DefaultAtBlobUploadService } from '../blob/AtBlobUploadService.js';

// Writes
import { DefaultAtWriteNormalizer } from '../writes/DefaultAtWriteNormalizer.js';
import { DefaultAtWritePolicyGate } from '../writes/DefaultAtWritePolicyGate.js';
import { DefaultAtWriteGateway } from '../writes/DefaultAtWriteGateway.js';
import { DefaultCanonicalClientWriteService } from '../writes/DefaultCanonicalClientWriteService.js';
import { InMemoryAtWriteResultStore } from '../writes/AtWriteResultStore.js';

import type { SigningService } from '../../core-domain/contracts/SigningContracts.js';
import type { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';
import type { RepositoryState } from '../../atproto/repo/AtprotoRepoState.js';

// ============================================================================
// Test constants
// ============================================================================

const TEST_DID              = 'did:plc:phase7writeprooftest00001';
const TEST_HANDLE           = 'alice.test.pods';
const TEST_CANONICAL_ID     = 'https://pods.test/users/alice';
const TEST_CONTEXT_ID       = 'pods.test';
const TEST_PASSWORD         = 'harness-test-password-123';
const AT_SESSION_SECRET     = 'phase7-write-proof-secret-at-least-32chars!';
const HARNESS_PORT          = 19870;

// ============================================================================
// Minimal in-memory IdentityBindingRepository
// ============================================================================

class InMemoryIdentityBindingRepository implements IdentityBindingRepository {
  private store = new Map<string, IdentityBinding>();
  private byDid = new Map<string, string>();
  private byHandle = new Map<string, string>();
  private byActor = new Map<string, string>();
  private byWebId = new Map<string, string>();

  async getByCanonicalAccountId(id: string) { return this.store.get(id) ?? null; }
  async getByAtprotoDid(did: string) {
    const id = this.byDid.get(did); return id ? this.store.get(id) ?? null : null;
  }
  async getByAtprotoHandle(handle: string) {
    const id = this.byHandle.get(handle.toLowerCase()); return id ? this.store.get(id) ?? null : null;
  }
  async findByHandle(handle: string) { return this.getByAtprotoHandle(handle); }
  async getByActivityPubActorUri(uri: string) {
    const id = this.byActor.get(uri); return id ? this.store.get(id) ?? null : null;
  }
  async getByWebId(webId: string) {
    const id = this.byWebId.get(webId); return id ? this.store.get(id) ?? null : null;
  }
  async getByContextAndUsername(contextId: string, username: string) {
    for (const b of this.store.values()) {
      if (b.contextId !== contextId) continue;
      const slug = b.activityPubActorUri.split('/').filter(Boolean).pop();
      if (slug === username) return b;
    }
    return null;
  }
  async create(b: IdentityBinding) {
    if (this.store.has(b.canonicalAccountId)) throw new Error('DUPLICATE');
    this._write(b);
  }
  async update(b: IdentityBinding) {
    if (!this.store.has(b.canonicalAccountId)) throw new Error('NOT_FOUND');
    this._write(b);
  }
  async upsert(b: IdentityBinding) { this._write(b); }
  async delete(id: string) { return this.store.delete(id); }
  async listByContext(contextId: string, limit = 100, offset = 0) {
    return [...this.store.values()].filter(b => b.contextId === contextId).slice(offset, offset + limit);
  }
  async listByStatus(status: any, limit = 100, offset = 0) {
    return [...this.store.values()].filter(b => b.status === status).slice(offset, offset + limit);
  }
  async listWithPendingPlcUpdates(limit = 100, offset = 0) { return []; }
  async countByContext(contextId: string) {
    return [...this.store.values()].filter(b => b.contextId === contextId).length;
  }
  async exists(id: string) { return this.store.has(id); }
  async didExists(did: string) { return this.byDid.has(did); }
  async handleExists(handle: string) { return this.byHandle.has(handle.toLowerCase()); }
  async actorUriExists(uri: string) { return this.byActor.has(uri); }
  async getBatch(ids: string[]) {
    const m = new Map<string, IdentityBinding>();
    for (const id of ids) { const b = this.store.get(id); if (b) m.set(id, b); }
    return m;
  }
  async transaction<T>(cb: (r: IdentityBindingRepository) => Promise<T>) { return cb(this); }
  async health() { return true; }

  private _write(b: IdentityBinding) {
    this.store.set(b.canonicalAccountId, b);
    if (b.atprotoDid) this.byDid.set(b.atprotoDid, b.canonicalAccountId);
    if (b.atprotoHandle) this.byHandle.set(b.atprotoHandle.toLowerCase(), b.canonicalAccountId);
    if (b.activityPubActorUri) this.byActor.set(b.activityPubActorUri, b.canonicalAccountId);
    if (b.webId) this.byWebId.set(b.webId, b.canonicalAccountId);
  }
}

// ============================================================================
// Minimal mock Redis (for DefaultAtCommitPersistenceService state writes)
// ============================================================================

function makeMockRedis() {
  const data = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    _data: data,
    async set(key: string, value: string) { data.set(key, value); },
    async get(key: string) { return data.get(key) ?? null; },
    async del(...keys: string[]) { keys.forEach(k => data.delete(k)); return keys.length; },
    async exists(key: string) { return data.has(key) ? 1 : 0; },
    async sadd(key: string, ...members: string[]) {
      if (!sets.has(key)) sets.set(key, new Set());
      members.forEach(m => sets.get(key)!.add(m));
      return members.length;
    },
    async srem(key: string, ...members: string[]) {
      sets.get(key)?.forEach(m => members.includes(m) && sets.get(key)!.delete(m));
    },
    async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
    async scard(key: string) { return sets.get(key)?.size ?? 0; },
    async ping() { return 'PONG'; },
    on(_event: string, _fn: any) {},
  };
}

// ============================================================================
// Build the full DI chain
// ============================================================================

async function buildDeps() {
  const identityRepo  = new InMemoryIdentityBindingRepository();
  const aliasStore    = new InMemoryAtAliasStore();
  const repoRegistry  = new InMemoryAtprotoRepoRegistry();
  const mockRedis     = makeMockRedis();

  // Seed test identity binding
  const now = new Date().toISOString();
  await identityRepo.create({
    canonicalAccountId: TEST_CANONICAL_ID,
    contextId:          TEST_CONTEXT_ID,
    webId:              TEST_CANONICAL_ID,
    activityPubActorUri: `https://pods.test/users/alice`,
    atprotoDid:          TEST_DID,
    atprotoHandle:       TEST_HANDLE,
    canonicalDidMethod:  'did:plc',
    atprotoPdsEndpoint:  null,
    apSigningKeyRef:     'https://pods.test/keys/ap-signing',
    atSigningKeyRef:     'https://pods.test/keys/at-signing',
    atRotationKeyRef:    'https://pods.test/keys/at-rotation',
    plc: {
      opCid: null, rotationKeyRef: 'https://pods.test/keys/at-rotation',
      plcUpdateState: null, lastSubmittedAt: null, lastConfirmedAt: null, lastError: null,
    },
    didWeb: null,
    accountLinks: { apAlsoKnownAs: [], atAlsoKnownAs: [], relMe: [], webIdSameAs: [], webIdAccounts: [] },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  // Seed repo state
  const repoState: RepositoryState = {
    did: TEST_DID,
    rev: '0',
    rootCid: null,
    collections: [{ nsid: 'app.bsky.feed.post' }],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await repoRegistry.register(repoState);

  // Mock signing service (returns a valid-looking base64url signature)
  const mockSig = Buffer.from('mock-secp256k1-signature-for-phase7-proof').toString('base64url');
  const signingService: SigningService = {
    signAtprotoCommit: async (req) => ({
      did:                req.did,
      keyId:              `${req.did}#atproto`,
      signatureBase64Url: mockSig,
      algorithm:          'k256',
      signedAt:           new Date().toISOString(),
    }),
    signPlcOperation: async (req) => ({
      did:                req.did,
      keyId:              `${req.did}#atproto-rotation-key`,
      signatureBase64Url: mockSig,
      algorithm:          'k256',
      signedAt:           new Date().toISOString(),
    }),
    getAtprotoPublicKey: async () => { throw new Error('not used in proof'); },
    generateApSigningKey: async () => { throw new Error('not used in proof'); },
    generateAtSigningKey: async () => { throw new Error('not used in proof'); },
    getApPublicKey: async () => { throw new Error('not used in proof'); },
  };

  // No-op event publisher
  const eventPublisher: EventPublisher = {
    publish: async () => {},
    publishBatch: async () => {},
  };

  // Mock password verifier (accepts any password for the test account)
  const passwordVerifier: AtPasswordVerifier = {
    verify: async (canonicalAccountId, _password) => {
      if (canonicalAccountId !== TEST_CANONICAL_ID) throw new Error('Unknown account');
      return 'full';
    },
  };

  // Shared services
  const tokenService      = new DefaultAtSessionTokenService({ secret: AT_SESSION_SECRET });
  const accountResolver   = new DefaultAtAccountResolver(identityRepo);
  const sessionService    = new DefaultAtSessionService(accountResolver, passwordVerifier, tokenService);

  // Projection worker
  const commitBuilder      = new DefaultAtCommitBuilder(signingService);
  const persistenceService = new DefaultAtCommitPersistenceService(aliasStore, eventPublisher, mockRedis);
  const rkeyService        = new DefaultAtRkeyService();
  const blobStore          = new DefaultAtBlobStore();
  const blobMapper         = new DefaultBlobReferenceMapper();
  const blobUploadService  = new DefaultAtBlobUploadService(blobStore, blobMapper);
  const attachmentMediaResolver = {
    resolveMedia: async (_did: string, _mediaId: string) => null,
  };

  const projectionWorker = new DefaultAtProjectionWorker(
    new DefaultAtProjectionPolicy(),
    identityRepo,
    repoRegistry,
    new DefaultProfileRecordSerializer(),
    new DefaultPostRecordSerializer(),
    new DefaultStandardDocumentRecordSerializer(),
    rkeyService,
    aliasStore,
    commitBuilder,
    persistenceService,
    eventPublisher,
    {
      mediaResolver:       { resolveAvatarBlob: async () => null, resolveBannerBlob: async () => null },
      facetBuilder:        new DefaultFacetBuilder(),
      embedBuilder:        new DefaultEmbedBuilder(
        new DefaultImageEmbedBuilder(blobUploadService, attachmentMediaResolver),
        new DefaultVideoEmbedBuilder(blobUploadService, attachmentMediaResolver),
      ),
      recordRefResolver:   new DefaultAtRecordRefResolver(aliasStore),
      subjectResolver:     new DefaultAtSubjectResolver(identityRepo),
      targetAliasResolver: new DefaultAtTargetAliasResolver(aliasStore),
      followSerializer:    new DefaultFollowRecordSerializer(),
      likeSerializer:      new DefaultLikeRecordSerializer(),
      repostSerializer:    new DefaultRepostRecordSerializer(),
    },
  );

  // Write gateway
  const resultStore   = new InMemoryAtWriteResultStore();
  const writeService  = new DefaultCanonicalClientWriteService({ projectionWorker, aliasStore, resultStore, identityRepo });
  const writeGateway  = new DefaultAtWriteGateway({
    normalizer:  new DefaultAtWriteNormalizer(),
    policyGate:  new DefaultAtWritePolicyGate(identityRepo, aliasStore),
    writeService,
    resultStore,
  });

  // Record reader + CAR exporter
  const handleResolutionReader = new DefaultHandleResolutionReader(identityRepo);
  const recordReader           = new DefaultAtRecordReader(handleResolutionReader, aliasStore, repoRegistry);
  const carExporter            = new DefaultAtCarExporter(repoRegistry);
  const firehoseSubscriptions  = new DefaultAtFirehoseSubscriptionManager(new InMemoryAtFirehoseCursorStore());

  const xrpcServer = new DefaultAtXrpcServer({
    recordReader,
    carExporter,
    handleResolutionReader,
    firehoseSubscriptions,
    repoRegistry,
    serverConfig: { hostname: 'localhost', inviteCodeRequired: false, acceptsNewAccounts: false },
    sessionService,
    accountResolver,
    passwordVerifier,
    writeGateway,
  });

  return { xrpcServer, sessionService };
}

// ============================================================================
// Run the proof
// ============================================================================

async function run() {
  console.log('\n=====================================================');
  console.log('  Phase 7 Write Proof — createSession → createRecord');
  console.log('=====================================================\n');

  const { xrpcServer, sessionService } = await buildDeps();

  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    ['application/json'],
    { parseAs: 'string' },
    (req, body, done) => { try { done(null, JSON.parse(body as string)); } catch (e: any) { done(e); } }
  );

  registerAtXrpcRoutes(app, { xrpcServer, sessionService });
  await app.listen({ port: HARNESS_PORT, host: '127.0.0.1' });

  const base = `http://127.0.0.1:${HARNESS_PORT}`;

  try {
    // ------------------------------------------------------------------
    // Step 1: createSession
    // ------------------------------------------------------------------
    console.log(`[1] POST /xrpc/com.atproto.server.createSession`);
    console.log(`    identifier: ${TEST_HANDLE}  password: ${TEST_PASSWORD}`);

    const sessionRes = await fetch(`${base}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: TEST_HANDLE, password: TEST_PASSWORD }),
    });

    if (!sessionRes.ok) {
      const text = await sessionRes.text();
      throw new Error(`createSession failed ${sessionRes.status}: ${text}`);
    }

    const session: any = await sessionRes.json();
    console.log(`    ✓ did: ${session.did}`);
    console.log(`    ✓ handle: ${session.handle}`);
    console.log(`    ✓ accessJwt: ${session.accessJwt?.slice(0, 40)}...`);

    const { accessJwt } = session;

    // ------------------------------------------------------------------
    // Step 2: createRecord — app.bsky.feed.post
    // ------------------------------------------------------------------
    console.log(`\n[2] POST /xrpc/com.atproto.repo.createRecord`);
    console.log(`    repo: ${TEST_DID}  collection: app.bsky.feed.post`);

    const createRes = await fetch(`${base}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessJwt}`,
      },
      body: JSON.stringify({
        repo:       TEST_DID,
        collection: 'app.bsky.feed.post',
        record: {
          $type:     'app.bsky.feed.post',
          text:      'Phase 7 write proof — first canonical post via AT!',
          createdAt: new Date().toISOString(),
        },
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`createRecord failed ${createRes.status}: ${text}`);
    }

    const created: any = await createRes.json();
    console.log(`    ✓ uri: ${created.uri}`);
    console.log(`    ✓ cid: ${created.cid}`);

    // ------------------------------------------------------------------
    // Assertions
    // ------------------------------------------------------------------
    const uriOk  = typeof created.uri === 'string' && created.uri.startsWith(`at://${TEST_DID}/app.bsky.feed.post/`);
    const cidOk  = typeof created.cid === 'string' && created.cid.length > 0;

    if (!uriOk)  throw new Error(`URI assertion failed: ${created.uri}`);
    if (!cidOk)  throw new Error(`CID assertion failed: ${created.cid}`);

    console.log('\n=====================================================');
    console.log('  PROOF PASSED');
    console.log(`  URI: ${created.uri}`);
    console.log(`  CID: ${created.cid}`);
    console.log('=====================================================\n');

  } finally {
    await app.close();
  }
}

run().catch(err => {
  console.error('\n[PROOF FAILED]', err.message);
  process.exit(1);
});
