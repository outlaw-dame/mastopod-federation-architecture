import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { RedisIdentityBindingRepository } from '../../core-domain/identity/RedisIdentityBindingRepository.js';

const SIDEcar_BASE = process.env.UNIFIED_SIDECAR_BASE ?? 'http://localhost:8086';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const MOCK_PDS_HOST = process.env.EXTERNAL_PDS_MOCK_HOST ?? '127.0.0.1';
const MOCK_PDS_PORT = Number.parseInt(process.env.EXTERNAL_PDS_MOCK_PORT ?? '8787', 10);
const EXTERNAL_PASSWORD = process.env.EXTERNAL_PDS_MOCK_PASSWORD ?? 'ExternalModePass123!';
const MOCK_REPO_CAR = new TextEncoder().encode('mock-car-proof-external-repo');

const BINDING = {
  canonicalAccountId: 'http://localhost:3000/external-mode-proof',
  webId: 'http://localhost:3000/external-mode-proof',
  activityPubActorUri: 'http://localhost:3000/external-mode-proof',
  activityPubHandle: '@external-mode-proof@localhost',
  atprotoDid: 'did:plc:externalproof1234567890',
  atprotoHandle: 'external-mode-proof.test',
  atprotoPdsEndpoint: `http://${MOCK_PDS_HOST}:${MOCK_PDS_PORT}`,
  atprotoSource: 'external' as const,
  atprotoManaged: false,
  status: 'active' as const,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(url: string, init: RequestInit = {}): Promise<{
  status: number;
  body: any;
}> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return {
    status: response.status,
    body,
  };
}

async function requestBinary(url: string, init: RequestInit = {}): Promise<{
  status: number;
  headers: Headers;
  body: Uint8Array;
}> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
}

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL);
  const identityRepo = new RedisIdentityBindingRepository(redis);
  const records = new Map<string, { uri: string; cid: string; value: unknown }>();
  let rev = 0;
  let commitCid = 'bafyreiexternalgenesiscommit';

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${MOCK_PDS_HOST}:${MOCK_PDS_PORT}`);
      const authHeader = req.headers.authorization ?? '';

      if (req.method === 'POST' && url.pathname === '/xrpc/com.atproto.server.createSession') {
        const body = await readRequestBody(req);
        if (
          body.identifier !== BINDING.atprotoHandle &&
          body.identifier !== BINDING.atprotoDid
        ) {
          writeJson(res, 401, { error: 'AuthRequired', message: 'Invalid identifier or password' });
          return;
        }

        if (body.password !== EXTERNAL_PASSWORD) {
          writeJson(res, 401, { error: 'AuthRequired', message: 'Invalid identifier or password' });
          return;
        }

        writeJson(res, 200, {
          did: BINDING.atprotoDid,
          handle: BINDING.atprotoHandle,
          accessJwt: 'mock-upstream-access',
          refreshJwt: 'mock-upstream-refresh',
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/xrpc/com.atproto.server.refreshSession') {
        if (authHeader !== 'Bearer mock-upstream-refresh') {
          writeJson(res, 401, { error: 'AuthRequired', message: 'Refresh token invalid' });
          return;
        }

        writeJson(res, 200, {
          did: BINDING.atprotoDid,
          handle: BINDING.atprotoHandle,
          accessJwt: 'mock-upstream-access',
          refreshJwt: 'mock-upstream-refresh',
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/xrpc/com.atproto.repo.createRecord') {
        if (!authHeader.startsWith('Bearer mock-upstream-access')) {
          writeJson(res, 401, { error: 'AuthRequired', message: 'Access token invalid' });
          return;
        }

        const body = await readRequestBody(req);
        const rkey = String(body.rkey || `proof-${Date.now()}`);
        rev += 1;
        commitCid = `bafyreiexternalcommit${rev}`;
        const uri = `at://${BINDING.atprotoDid}/${body.collection}/${rkey}`;
        const cid = `bafyreiexternalrecord${rev}`;
        records.set(`${body.collection}/${rkey}`, {
          uri,
          cid,
          value: body.record,
        });

        writeJson(res, 200, {
          uri,
          cid,
          commit: { cid: commitCid, rev: String(rev) },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/xrpc/com.atproto.repo.getRecord') {
        const key = `${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`;
        const record = records.get(key);
        if (!record) {
          writeJson(res, 404, { error: 'RecordNotFound', message: `Record not found: ${key}` });
          return;
        }

        res.setHeader('atproto-repo-rev', String(rev));
        writeJson(res, 200, {
          uri: record.uri,
          cid: record.cid,
          value: record.value,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/xrpc/com.atproto.sync.getLatestCommit') {
        res.setHeader('atproto-repo-rev', String(rev));
        writeJson(res, 200, {
          cid: commitCid,
          rev: String(rev),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/xrpc/com.atproto.sync.getRepo') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/vnd.ipld.car');
        res.setHeader('content-length', String(MOCK_REPO_CAR.byteLength));
        res.setHeader('atproto-repo-rev', String(rev));
        res.end(Buffer.from(MOCK_REPO_CAR));
        return;
      }

      writeJson(res, 404, { error: 'MethodNotImplemented', message: 'Route not found' });
    } catch (error) {
      writeJson(res, 500, {
        error: 'InternalServerError',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  try {
    server.listen(MOCK_PDS_PORT, MOCK_PDS_HOST);
    await once(server, 'listening');

    await identityRepo.upsert({
      canonicalAccountId: BINDING.canonicalAccountId,
      contextId: 'default',
      webId: BINDING.webId,
      activityPubActorUri: BINDING.activityPubActorUri,
      atprotoDid: BINDING.atprotoDid,
      atprotoHandle: BINDING.atprotoHandle,
      canonicalDidMethod: null,
      atprotoPdsEndpoint: BINDING.atprotoPdsEndpoint,
      atprotoSource: BINDING.atprotoSource,
      atprotoManaged: BINDING.atprotoManaged,
      apSigningKeyRef: `${BINDING.canonicalAccountId}#ap-signing`,
      atSigningKeyRef: null,
      atRotationKeyRef: null,
      plc: null,
      didWeb: null,
      accountLinks: {
        apAlsoKnownAs: [],
        atAlsoKnownAs: [],
        relMe: [],
        webIdSameAs: [],
        webIdAccounts: [],
      },
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const createSession = await requestJson(
      `${SIDEcar_BASE}/xrpc/com.atproto.server.createSession`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          identifier: BINDING.atprotoHandle,
          password: EXTERNAL_PASSWORD,
        }),
      }
    );

    assert(createSession.status === 200, `createSession failed: ${createSession.status}`);
    assert(createSession.body.did === BINDING.atprotoDid, 'createSession returned wrong DID');
    assert(createSession.body.handle === BINDING.atprotoHandle, 'createSession returned wrong handle');
    assert(typeof createSession.body.accessJwt === 'string', 'createSession missing local accessJwt');
    assert(typeof createSession.body.refreshJwt === 'string', 'createSession missing local refreshJwt');
    assert(!('tokenId' in createSession.body), 'createSession leaked internal token identifier');

    const rotated = await requestJson(
      `${SIDEcar_BASE}/xrpc/com.atproto.server.refreshSession`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createSession.body.refreshJwt as string}`,
        },
      }
    );

    assert(rotated.status === 200, `refreshSession failed: ${rotated.status}`);
    assert(rotated.body.did === BINDING.atprotoDid, 'refreshSession returned wrong DID');
    assert(rotated.body.handle === BINDING.atprotoHandle, 'refreshSession returned wrong handle');
    assert(typeof rotated.body.accessJwt === 'string', 'refreshSession missing accessJwt');
    assert(typeof rotated.body.refreshJwt === 'string', 'refreshSession missing refreshJwt');
    assert(!('tokenId' in rotated.body), 'refreshSession leaked internal token identifier');

    const accessJwt = rotated.body.accessJwt as string;

    const createRecord = await requestJson(
      `${SIDEcar_BASE}/xrpc/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessJwt}`,
        },
        body: JSON.stringify({
          repo: BINDING.atprotoDid,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text: 'external pds mode proof',
            createdAt: new Date().toISOString(),
          },
        }),
      }
    );

    assert(createRecord.status === 200, `createRecord failed: ${createRecord.status}`);
    const uri = String(createRecord.body.uri);
    const rkey = uri.split('/').pop();
    assert(rkey, 'createRecord did not return an rkey');

    const getRecord = await requestJson(
      `${SIDEcar_BASE}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(BINDING.atprotoDid)}&collection=${encodeURIComponent('app.bsky.feed.post')}&rkey=${encodeURIComponent(rkey)}`,
      {
        method: 'GET',
      }
    );

    assert(getRecord.status === 200, `getRecord failed: ${getRecord.status}`);
    assert(getRecord.body.uri === createRecord.body.uri, 'getRecord returned the wrong URI');

    const getLatestCommit = await requestJson(
      `${SIDEcar_BASE}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(BINDING.atprotoDid)}`,
      {
        method: 'GET',
      }
    );

    assert(getLatestCommit.status === 200, `getLatestCommit failed: ${getLatestCommit.status}`);
    assert(getLatestCommit.body.rev === '1', 'getLatestCommit returned wrong rev');

    const getRepo = await requestBinary(
      `${SIDEcar_BASE}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(BINDING.atprotoDid)}`,
      {
        method: 'GET',
      }
    );

    assert(getRepo.status === 200, `getRepo failed: ${getRepo.status}`);
    assert(
      getRepo.headers.get('content-type') === 'application/vnd.ipld.car',
      'getRepo returned wrong content-type'
    );
    assert(
      Buffer.compare(Buffer.from(getRepo.body), Buffer.from(MOCK_REPO_CAR)) === 0,
      'getRepo returned the wrong CAR payload'
    );

    const replayedRefresh = await requestJson(
      `${SIDEcar_BASE}/xrpc/com.atproto.server.refreshSession`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createSession.body.refreshJwt as string}`,
        },
      }
    );

    assert(replayedRefresh.status === 401, `refresh replay should fail: ${replayedRefresh.status}`);

    const postReplayWrite = await requestJson(
      `${SIDEcar_BASE}/xrpc/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessJwt}`,
        },
        body: JSON.stringify({
          repo: BINDING.atprotoDid,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text: 'post replay compromise check',
            createdAt: new Date().toISOString(),
          },
        }),
      }
    );

    assert(
      postReplayWrite.status === 401,
      `descendant access token should be invalid after refresh replay: ${postReplayWrite.status}`
    );

    const storedUpstreamKeys = await redis.keys('at:external:session:*');
    assert(storedUpstreamKeys.length > 0, 'no encrypted upstream external session was stored');

    console.log(
      JSON.stringify(
        {
          ok: true,
          sidecarBase: SIDEcar_BASE,
          pdsOrigin: BINDING.atprotoPdsEndpoint,
          did: BINDING.atprotoDid,
          handle: BINDING.atprotoHandle,
          uri: createRecord.body.uri,
          rev: getLatestCommit.body.rev,
          repoCarBytes: getRepo.body.byteLength,
          refreshed: true,
          replayCompromisedFamily: true,
          storedSessionKeys: storedUpstreamKeys.length,
        },
        null,
        2
      )
    );
  } finally {
    server.close();
    await once(server, 'close').catch(() => undefined);
    await identityRepo.delete(BINDING.canonicalAccountId);

    const sessionKeys = await redis.keys('at:external:session:*');
    if (sessionKeys.length > 0) {
      await redis.del(...sessionKeys);
    }
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
