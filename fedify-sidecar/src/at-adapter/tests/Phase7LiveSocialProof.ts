/*
 * Live Phase 7 social-proof runner.
 *
 * Executes in order:
 *   1. profile putRecord + getRecord
 *   2. follow create + getRecord + delete + getRecord
 *   3. create one subject post for strong-ref tests
 *   4. like create + getRecord + delete + getRecord
 *   5. repost create + getRecord + delete + getRecord
 *
 * Expected env vars:
 *   PHASE7_SIDECAR_BASE (default: http://localhost:8085)
 *   PHASE7_IDENTIFIER (default: did:plc:atproto365133)
 *   PHASE7_PASSWORD (default: Phase7LivePass123)
 *   PHASE7_REPO_DID (default: did:plc:atproto365133)
 *   PHASE7_FOLLOW_SUBJECT_DID (default: did:plc:remotefollowtarget00001)
 */

const sidecarBase = process.env['PHASE7_SIDECAR_BASE'] ?? 'http://localhost:8085';
const identifier = process.env['PHASE7_IDENTIFIER'] ?? 'did:plc:atproto365133';
const password = process.env['PHASE7_PASSWORD'] ?? 'Phase7LivePass123';
const repoDid = process.env['PHASE7_REPO_DID'] ?? 'did:plc:atproto365133';
const followSubjectDid =
  process.env['PHASE7_FOLLOW_SUBJECT_DID'] ?? 'did:plc:remotefollowtarget00001';

async function asJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main(): Promise<void> {
  const sessionRes = await fetch(`${sidecarBase}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const sessionBody = await asJson(sessionRes);

  if (!sessionRes.ok) {
    console.log(JSON.stringify({ createSession: { status: sessionRes.status, body: sessionBody } }, null, 2));
    process.exit(1);
  }

  const accessJwt = sessionBody.accessJwt as string;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessJwt}`,
  };

  async function xrpcPost(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const res = await fetch(`${sidecarBase}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await asJson(res) };
  }

  async function getRecord(collection: string, rkey: string): Promise<{ status: number; body: any }> {
    const url =
      `${sidecarBase}/xrpc/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(repoDid)}` +
      `&collection=${encodeURIComponent(collection)}` +
      `&rkey=${encodeURIComponent(rkey)}`;
    const res = await fetch(url);
    return { status: res.status, body: await asJson(res) };
  }

  const profilePut = await xrpcPost('/xrpc/com.atproto.repo.putRecord', {
    repo: repoDid,
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
    record: {
      $type: 'app.bsky.actor.profile',
      displayName: 'Phase 7 Live Profile',
      description: 'profile putRecord regression proof',
    },
  });
  const profileRead = await getRecord('app.bsky.actor.profile', 'self');

  const followCreate = await xrpcPost('/xrpc/com.atproto.repo.createRecord', {
    repo: repoDid,
    collection: 'app.bsky.graph.follow',
    record: {
      $type: 'app.bsky.graph.follow',
      subject: followSubjectDid,
      createdAt: new Date().toISOString(),
    },
  });
  const followRkey = typeof followCreate.body?.uri === 'string' ? followCreate.body.uri.split('/').pop() : null;
  const followRead = followRkey ? await getRecord('app.bsky.graph.follow', followRkey) : null;
  const followDelete = followRkey
    ? await xrpcPost('/xrpc/com.atproto.repo.deleteRecord', {
        repo: repoDid,
        collection: 'app.bsky.graph.follow',
        rkey: followRkey,
      })
    : null;
  const followReadAfterDelete = followRkey ? await getRecord('app.bsky.graph.follow', followRkey) : null;

  const subjectPostCreate = await xrpcPost('/xrpc/com.atproto.repo.createRecord', {
    repo: repoDid,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: `Phase 7 live subject post ${Date.now()}`,
      createdAt: new Date().toISOString(),
    },
  });

  const likeCreate = await xrpcPost('/xrpc/com.atproto.repo.createRecord', {
    repo: repoDid,
    collection: 'app.bsky.feed.like',
    record: {
      $type: 'app.bsky.feed.like',
      subject: {
        uri: subjectPostCreate.body?.uri,
        cid: subjectPostCreate.body?.cid,
      },
      createdAt: new Date().toISOString(),
    },
  });
  const likeRkey = typeof likeCreate.body?.uri === 'string' ? likeCreate.body.uri.split('/').pop() : null;
  const likeRead = likeRkey ? await getRecord('app.bsky.feed.like', likeRkey) : null;
  const likeDelete = likeRkey
    ? await xrpcPost('/xrpc/com.atproto.repo.deleteRecord', {
        repo: repoDid,
        collection: 'app.bsky.feed.like',
        rkey: likeRkey,
      })
    : null;
  const likeReadAfterDelete = likeRkey ? await getRecord('app.bsky.feed.like', likeRkey) : null;

  const repostCreate = await xrpcPost('/xrpc/com.atproto.repo.createRecord', {
    repo: repoDid,
    collection: 'app.bsky.feed.repost',
    record: {
      $type: 'app.bsky.feed.repost',
      subject: {
        uri: subjectPostCreate.body?.uri,
        cid: subjectPostCreate.body?.cid,
      },
      createdAt: new Date().toISOString(),
    },
  });
  const repostRkey = typeof repostCreate.body?.uri === 'string' ? repostCreate.body.uri.split('/').pop() : null;
  const repostRead = repostRkey ? await getRecord('app.bsky.feed.repost', repostRkey) : null;
  const repostDelete = repostRkey
    ? await xrpcPost('/xrpc/com.atproto.repo.deleteRecord', {
        repo: repoDid,
        collection: 'app.bsky.feed.repost',
        rkey: repostRkey,
      })
    : null;
  const repostReadAfterDelete = repostRkey ? await getRecord('app.bsky.feed.repost', repostRkey) : null;

  console.log(
    JSON.stringify(
      {
        sidecarBase,
        createSession: { status: sessionRes.status, body: sessionBody },
        profile: { put: profilePut, read: profileRead },
        follow: {
          create: followCreate,
          read: followRead,
          delete: followDelete,
          readAfterDelete: followReadAfterDelete,
        },
        subjectPost: subjectPostCreate,
        like: {
          create: likeCreate,
          read: likeRead,
          delete: likeDelete,
          readAfterDelete: likeReadAfterDelete,
        },
        repost: {
          create: repostCreate,
          read: repostRead,
          delete: repostDelete,
          readAfterDelete: repostReadAfterDelete,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('[PHASE7 LIVE SOCIAL PROOF FAILED]', error);
  process.exit(1);
});