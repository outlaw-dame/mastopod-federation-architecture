import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { DefaultAtSessionTokenService } from '../auth/DefaultAtSessionTokenService.js';
import { RedisSessionFamilyStateStore } from '../auth/SessionFamilyStateStore.js';

const REDIS_URL = process.env["REDIS_URL"] ?? 'redis://localhost:6379';
const AT_SESSION_SECRET =
  process.env["AT_SESSION_SECRET"] ?? 'dev-session-secret-at-least-32-characters';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL);
  const prefix = `at:proof:session-family:${randomUUID()}`;
  const storeA = new RedisSessionFamilyStateStore(redis, prefix);
  const storeB = new RedisSessionFamilyStateStore(redis, prefix);
  const storeC = new RedisSessionFamilyStateStore(redis, prefix);

  const serviceA = new DefaultAtSessionTokenService({
    secret: AT_SESSION_SECRET,
    sessionStateStore: storeA,
  });
  const serviceB = new DefaultAtSessionTokenService({
    secret: AT_SESSION_SECRET,
    sessionStateStore: storeB,
  });
  const serviceC = new DefaultAtSessionTokenService({
    secret: AT_SESSION_SECRET,
    sessionStateStore: storeC,
  });

  try {
    const minted = await serviceA.mintSessionPair({
      canonicalAccountId: 'session-family-proof-account',
      did: 'did:plc:sessionfamilyproof1234567890',
      handle: 'session-family-proof.test',
      scope: 'full',
    });

    assert(
      typeof minted.sessionFamilyId === 'string' && minted.sessionFamilyId.length > 0,
      'mintSessionPair did not return a session family id'
    );

    const rotated = await serviceB.rotateRefreshSession(minted.refreshJwt);
    assert(rotated, 'second token service instance failed to rotate refresh token');
    assert(
      rotated.sessionFamilyId === minted.sessionFamilyId,
      'refresh rotation changed the session family id'
    );

    const replay = await serviceC.rotateRefreshSession(minted.refreshJwt);
    assert(replay === null, 'replayed refresh token should not rotate successfully');

    const family = await storeA.getFamily(minted.sessionFamilyId);
    assert(family, 'session family record missing from Redis');
    assert(
      family.status === 'compromised',
      `session family should be compromised after replay, got ${family.status}`
    );

    const descendantAccess = await serviceA.verifyAccessToken(rotated.accessJwt);
    assert(
      descendantAccess === null,
      'descendant access token should be invalid once replay compromises the family'
    );

    const currentRefresh = await serviceA.verifyRefreshToken(rotated.refreshJwt);
    assert(
      currentRefresh === null,
      'descendant refresh token should be invalid once replay compromises the family'
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionFamilyId: minted.sessionFamilyId,
          replayCompromisedFamily: true,
          rotatedRefreshTokenId: rotated.refreshTokenId,
        },
        null,
        2
      )
    );
  } finally {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
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
