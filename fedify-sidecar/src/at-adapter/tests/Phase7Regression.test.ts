import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DefaultAtAccountResolver } from '../auth/DefaultAtAccountResolver.js';
import { DefaultAtSessionService } from '../auth/DefaultAtSessionService.js';
import { DefaultAtSessionTokenService } from '../auth/DefaultAtSessionTokenService.js';
import type { AtPasswordVerifier } from '../auth/AtSessionTypes.js';
import { DefaultAtFirehoseSubscriptionManager } from '../firehose/AtFirehoseSubscriptionManager.js';
import { InMemoryAtFirehoseCursorStore } from '../firehose/AtFirehoseCursorStore.js';
import { DefaultHandleResolutionReader } from '../identity/HandleResolutionReader.js';
import { DefaultAtProjectionWorker } from '../projection/AtProjectionWorker.js';
import { DefaultAtProjectionPolicy } from '../projection/AtProjectionPolicy.js';
import { DefaultEmbedBuilder } from '../projection/serializers/EmbedBuilder.js';
import { DefaultFacetBuilder } from '../projection/serializers/FacetBuilder.js';
import { DefaultFollowRecordSerializer } from '../projection/serializers/FollowRecordSerializer.js';
import { DefaultImageEmbedBuilder } from '../projection/serializers/ImageEmbedBuilder.js';
import { DefaultLikeRecordSerializer } from '../projection/serializers/LikeRecordSerializer.js';
import { DefaultPostRecordSerializer } from '../projection/serializers/PostRecordSerializer.js';
import { DefaultProfileRecordSerializer } from '../projection/serializers/ProfileRecordSerializer.js';
import { DefaultRepostRecordSerializer } from '../projection/serializers/RepostRecordSerializer.js';
import { InMemoryAtAliasStore } from '../repo/AtAliasStore.js';
import { DefaultAtCarExporter } from '../repo/AtCarExporter.js';
import { DefaultAtCommitBuilder } from '../repo/AtCommitBuilder.js';
import { DefaultAtCommitPersistenceService } from '../repo/AtCommitPersistenceService.js';
import { DefaultAtRecordReader } from '../repo/AtRecordReader.js';
import { DefaultAtRecordRefResolver } from '../repo/AtRecordRefResolver.js';
import { DefaultAtRkeyService } from '../repo/AtRkeyService.js';
import { DefaultAtTargetAliasResolver } from '../repo/AtTargetAliasResolver.js';
import { DefaultAtWriteGateway } from '../writes/DefaultAtWriteGateway.js';
import { InMemoryAtWriteResultStore } from '../writes/AtWriteResultStore.js';
import { DefaultAtWriteNormalizer } from '../writes/DefaultAtWriteNormalizer.js';
import { DefaultAtWritePolicyGate } from '../writes/DefaultAtWritePolicyGate.js';
import { DefaultCanonicalClientWriteService } from '../writes/DefaultCanonicalClientWriteService.js';
import { registerAtXrpcRoutes } from '../xrpc/AtXrpcFastifyBridge.js';
import { DefaultAtXrpcServer } from '../xrpc/AtXrpcServer.js';
import type { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';
import type { SigningService } from '../../core-domain/contracts/SigningContracts.js';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import { InMemoryAtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry.js';

const TEST_DID = 'did:plc:phase7regressiontest00001';
const TEST_HANDLE = 'alice.test.pods';
const TEST_CANONICAL_ID = 'https://pods.test/users/alice';
const TEST_CONTEXT_ID = 'pods.test';
const TEST_PASSWORD = 'phase7-regression-password';
const AT_SESSION_SECRET = 'phase7-regression-secret-at-least-32chars';

class InMemoryIdentityBindingRepository implements IdentityBindingRepository {
  private readonly store = new Map<string, IdentityBinding>();
  private readonly byDid = new Map<string, string>();
  private readonly byHandle = new Map<string, string>();
  private readonly byActor = new Map<string, string>();
  private readonly byWebId = new Map<string, string>();

  async getByCanonicalAccountId(id: string): Promise<IdentityBinding | null> {
    return this.store.get(id) ?? null;
  }

  async getByAtprotoDid(did: string): Promise<IdentityBinding | null> {
    const id = this.byDid.get(did);
    return id ? this.store.get(id) ?? null : null;
  }

  async getByAtprotoHandle(handle: string): Promise<IdentityBinding | null> {
    const id = this.byHandle.get(handle.toLowerCase());
    return id ? this.store.get(id) ?? null : null;
  }

  async findByHandle(handle: string): Promise<IdentityBinding | null> {
    return this.getByAtprotoHandle(handle);
  }

  async getByActivityPubActorUri(uri: string): Promise<IdentityBinding | null> {
    const id = this.byActor.get(uri);
    return id ? this.store.get(id) ?? null : null;
  }

  async getByWebId(webId: string): Promise<IdentityBinding | null> {
    const id = this.byWebId.get(webId);
    return id ? this.store.get(id) ?? null : null;
  }

  async getByContextAndUsername(contextId: string, username: string): Promise<IdentityBinding | null> {
    for (const binding of this.store.values()) {
      if (binding.contextId !== contextId) continue;
      const slug = binding.activityPubActorUri.split('/').filter(Boolean).pop();
      if (slug === username) return binding;
    }
    return null;
  }

  async create(binding: IdentityBinding): Promise<void> {
    this.write(binding);
  }

  async update(binding: IdentityBinding): Promise<void> {
    this.write(binding);
  }

  async upsert(binding: IdentityBinding): Promise<void> {
    this.write(binding);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async listByContext(contextId: string, limit = 100, offset = 0): Promise<IdentityBinding[]> {
    return [...this.store.values()].filter((binding) => binding.contextId === contextId).slice(offset, offset + limit);
  }

  async listByStatus(status: IdentityBinding['status'], limit = 100, offset = 0): Promise<IdentityBinding[]> {
    return [...this.store.values()].filter((binding) => binding.status === status).slice(offset, offset + limit);
  }

  async listWithPendingPlcUpdates(_limit = 100, _offset = 0): Promise<IdentityBinding[]> {
    return [];
  }

  async countByContext(contextId: string): Promise<number> {
    return [...this.store.values()].filter((binding) => binding.contextId === contextId).length;
  }

  async exists(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  async didExists(did: string): Promise<boolean> {
    return this.byDid.has(did);
  }

  async handleExists(handle: string): Promise<boolean> {
    return this.byHandle.has(handle.toLowerCase());
  }

  async actorUriExists(uri: string): Promise<boolean> {
    return this.byActor.has(uri);
  }

  async getBatch(ids: string[]): Promise<Map<string, IdentityBinding>> {
    const result = new Map<string, IdentityBinding>();
    for (const id of ids) {
      const binding = this.store.get(id);
      if (binding) result.set(id, binding);
    }
    return result;
  }

  async transaction<T>(callback: (repo: IdentityBindingRepository) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async health(): Promise<boolean> {
    return true;
  }

  private write(binding: IdentityBinding): void {
    this.store.set(binding.canonicalAccountId, binding);
    if (binding.atprotoDid) this.byDid.set(binding.atprotoDid, binding.canonicalAccountId);
    if (binding.atprotoHandle) this.byHandle.set(binding.atprotoHandle.toLowerCase(), binding.canonicalAccountId);
    if (binding.activityPubActorUri) this.byActor.set(binding.activityPubActorUri, binding.canonicalAccountId);
    if (binding.webId) this.byWebId.set(binding.webId, binding.canonicalAccountId);
  }
}

function makeMockRedis() {
  const data = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async del(...keys: string[]) {
      keys.forEach((key) => data.delete(key));
      return keys.length;
    },
    async exists(key: string) {
      return data.has(key) ? 1 : 0;
    },
    async sadd(key: string, ...members: string[]) {
      if (!sets.has(key)) sets.set(key, new Set());
      members.forEach((member) => sets.get(key)?.add(member));
      return members.length;
    },
    async srem(key: string, ...members: string[]) {
      const set = sets.get(key);
      if (!set) return 0;
      members.forEach((member) => set.delete(member));
      return members.length;
    },
    async smembers(key: string) {
      return [...(sets.get(key) ?? new Set())];
    },
    async scard(key: string) {
      return sets.get(key)?.size ?? 0;
    },
    async ping() {
      return 'PONG';
    },
    on(_event: string, _handler: unknown) {},
  };
}

interface Harness {
  app: FastifyInstance;
  repoRegistry: InMemoryAtprotoRepoRegistry;
  signCommitCalls: Array<Parameters<SigningService['signAtprotoCommit']>[0]>;
}

async function buildHarness(): Promise<Harness> {
  const identityRepo = new InMemoryIdentityBindingRepository();
  const aliasStore = new InMemoryAtAliasStore();
  const repoRegistry = new InMemoryAtprotoRepoRegistry();
  const mockRedis = makeMockRedis();
  const signCommitCalls: Array<Parameters<SigningService['signAtprotoCommit']>[0]> = [];

  const now = new Date().toISOString();
  await identityRepo.create({
    canonicalAccountId: TEST_CANONICAL_ID,
    contextId: TEST_CONTEXT_ID,
    webId: TEST_CANONICAL_ID,
    activityPubActorUri: 'https://pods.test/users/alice',
    atprotoDid: TEST_DID,
    atprotoHandle: TEST_HANDLE,
    canonicalDidMethod: 'did:plc',
    atprotoPdsEndpoint: null,
    apSigningKeyRef: 'https://pods.test/keys/ap-signing',
    atSigningKeyRef: 'https://pods.test/keys/at-signing',
    atRotationKeyRef: 'https://pods.test/keys/at-rotation',
    plc: {
      opCid: null,
      rotationKeyRef: 'https://pods.test/keys/at-rotation',
      plcUpdateState: null,
      lastSubmittedAt: null,
      lastConfirmedAt: null,
      lastError: null,
    },
    didWeb: null,
    accountLinks: { apAlsoKnownAs: [], atAlsoKnownAs: [], relMe: [], webIdSameAs: [], webIdAccounts: [] },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  const signingService: SigningService = {
    signAtprotoCommit: async (req) => {
      signCommitCalls.push(req);
      return {
        did: req.did,
        keyId: `${req.did}#atproto`,
        signatureBase64Url: Buffer.from('phase7-regression-signature').toString('base64url'),
        algorithm: 'k256',
        signedAt: new Date().toISOString(),
      };
    },
    signPlcOperation: async (req) => ({
      did: req.did,
      keyId: `${req.did}#atproto-rotation-key`,
      signatureBase64Url: Buffer.from('phase7-regression-plc-signature').toString('base64url'),
      algorithm: 'k256',
      signedAt: new Date().toISOString(),
    }),
    getAtprotoPublicKey: async () => {
      throw new Error('not used in regression test');
    },
    generateApSigningKey: async () => {
      throw new Error('not used in regression test');
    },
    generateAtSigningKey: async () => {
      throw new Error('not used in regression test');
    },
    getApPublicKey: async () => {
      throw new Error('not used in regression test');
    },
  };

  const eventPublisher: EventPublisher = {
    publish: async () => {},
    publishBatch: async () => {},
  };

  const passwordVerifier: AtPasswordVerifier = {
    verify: async (canonicalAccountId, password) => {
      if (canonicalAccountId !== TEST_CANONICAL_ID || password !== TEST_PASSWORD) {
        const error = new Error('Invalid credentials') as Error & { status?: number; code?: string };
        error.status = 401;
        error.code = 'AUTH_FAILED';
        throw error;
      }
      return 'full';
    },
  };

  const tokenService = new DefaultAtSessionTokenService({ secret: AT_SESSION_SECRET });
  const accountResolver = new DefaultAtAccountResolver(identityRepo);
  const sessionService = new DefaultAtSessionService(accountResolver, passwordVerifier, tokenService);
  const rkeyService = new DefaultAtRkeyService();
  const persistenceService = new DefaultAtCommitPersistenceService(aliasStore, eventPublisher, mockRedis);
  const commitBuilder = new DefaultAtCommitBuilder(signingService);

  const projectionWorker = new DefaultAtProjectionWorker(
    new DefaultAtProjectionPolicy(),
    identityRepo,
    repoRegistry,
    new DefaultProfileRecordSerializer(),
    new DefaultPostRecordSerializer(),
    rkeyService,
    aliasStore,
    commitBuilder,
    persistenceService,
    eventPublisher,
    {
      mediaResolver: { resolveAvatarBlob: async () => null, resolveBannerBlob: async () => null },
      facetBuilder: new DefaultFacetBuilder(),
      embedBuilder: new DefaultEmbedBuilder(new DefaultImageEmbedBuilder()),
      recordRefResolver: new DefaultAtRecordRefResolver(aliasStore),
      subjectResolver: new DefaultAtAccountResolver(identityRepo) as never,
      targetAliasResolver: new DefaultAtTargetAliasResolver(aliasStore),
      followSerializer: new DefaultFollowRecordSerializer(),
      likeSerializer: new DefaultLikeRecordSerializer(),
      repostSerializer: new DefaultRepostRecordSerializer(),
    },
  );

  const resultStore = new InMemoryAtWriteResultStore();
  const writeService = new DefaultCanonicalClientWriteService({
    projectionWorker,
    aliasStore,
    resultStore,
    identityRepo,
  });
  const writeGateway = new DefaultAtWriteGateway({
    normalizer: new DefaultAtWriteNormalizer(),
    policyGate: new DefaultAtWritePolicyGate(identityRepo, aliasStore),
    writeService,
    resultStore,
  });

  const handleResolutionReader = new DefaultHandleResolutionReader(identityRepo);
  const xrpcServer = new DefaultAtXrpcServer({
    recordReader: new DefaultAtRecordReader(handleResolutionReader, aliasStore, repoRegistry),
    carExporter: new DefaultAtCarExporter(repoRegistry),
    handleResolutionReader,
    firehoseSubscriptions: new DefaultAtFirehoseSubscriptionManager(new InMemoryAtFirehoseCursorStore()),
    repoRegistry,
    serverConfig: { hostname: 'localhost', inviteCodeRequired: false, acceptsNewAccounts: false },
    sessionService,
    accountResolver,
    passwordVerifier,
    writeGateway,
  });

  const app = Fastify({ logger: false });
  registerAtXrpcRoutes(app, { xrpcServer, sessionService });
  await app.ready();

  return { app, repoRegistry, signCommitCalls };
}

function jsonBody(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

describe('Phase 7 regressions', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('bootstraps repo state on first write, signs with canonicalAccountId, and exposes latest commit rev/CID', async () => {
    expect(await harness.repoRegistry.getRepoState(TEST_DID)).toBeNull();

    const sessionResponse = await harness.app.inject({
      method: 'POST',
      url: '/xrpc/com.atproto.server.createSession',
      headers: { 'content-type': 'application/json' },
      payload: { identifier: TEST_HANDLE, password: TEST_PASSWORD },
    });

    expect(sessionResponse.statusCode).toBe(200);
    const session = jsonBody(sessionResponse) as { accessJwt: string; did: string };

    const createResponse = await harness.app.inject({
      method: 'POST',
      url: '/xrpc/com.atproto.repo.createRecord',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessJwt}`,
      },
      payload: {
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: 'phase 7 regression write',
          createdAt: new Date().toISOString(),
        },
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = jsonBody(createResponse) as { uri: string; cid: string; commit?: { rev: string } };
    expect(created.uri.startsWith(`at://${TEST_DID}/app.bsky.feed.post/`)).toBe(true);
    expect(created.cid.length).toBeGreaterThan(0);

    expect(harness.signCommitCalls).toHaveLength(1);
    expect(harness.signCommitCalls[0]).toMatchObject({
      canonicalAccountId: TEST_CANONICAL_ID,
      did: TEST_DID,
    });

    const repoState = await harness.repoRegistry.getRepoState(TEST_DID);
    expect(repoState).not.toBeNull();
    expect(repoState?.rev).toBe('1');
    expect(repoState?.rootCid).toBeTruthy();

    const latestCommitResponse = await harness.app.inject({
      method: 'GET',
      url: `/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(TEST_DID)}`,
    });

    expect(latestCommitResponse.statusCode).toBe(200);
    const latestCommit = jsonBody(latestCommitResponse) as { cid: string; rev: string };
    expect(latestCommit.rev).toBe(repoState?.rev);
    expect(latestCommit.cid).toBe(repoState?.rootCid);
  });

  it('returns 401 AuthRequired on bad password', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/xrpc/com.atproto.server.createSession',
      headers: { 'content-type': 'application/json' },
      payload: { identifier: TEST_HANDLE, password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(jsonBody(response)).toEqual({
      error: 'AuthRequired',
      message: 'Invalid credentials',
    });
  });

  it('returns a profile write result and readback for putRecord', async () => {
    const sessionResponse = await harness.app.inject({
      method: 'POST',
      url: '/xrpc/com.atproto.server.createSession',
      headers: { 'content-type': 'application/json' },
      payload: { identifier: TEST_HANDLE, password: TEST_PASSWORD },
    });

    expect(sessionResponse.statusCode).toBe(200);
    const session = jsonBody(sessionResponse) as { accessJwt: string };

    const putResponse = await harness.app.inject({
      method: 'POST',
      url: '/xrpc/com.atproto.repo.putRecord',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessJwt}`,
      },
      payload: {
        repo: TEST_DID,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
        record: {
          $type: 'app.bsky.actor.profile',
          displayName: 'Regression Profile',
          description: 'profile write should surface a result',
        },
      },
    });

    expect(putResponse.statusCode).toBe(200);
    const putBody = jsonBody(putResponse) as { uri: string; cid: string };
    expect(putBody.uri).toBe(`at://${TEST_DID}/app.bsky.actor.profile/self`);
    expect(putBody.cid.length).toBeGreaterThan(0);

    const readResponse = await harness.app.inject({
      method: 'GET',
      url:
        '/xrpc/com.atproto.repo.getRecord' +
        `?repo=${encodeURIComponent(TEST_DID)}` +
        `&collection=${encodeURIComponent('app.bsky.actor.profile')}` +
        '&rkey=self',
    });

    expect(readResponse.statusCode).toBe(200);
    expect(jsonBody(readResponse)).toMatchObject({
      uri: `at://${TEST_DID}/app.bsky.actor.profile/self`,
      cid: putBody.cid,
      value: { $type: 'app.bsky.actor.profile' },
    });
  });
});