import { Redis } from 'ioredis';
import { RedisIdentityBindingRepository } from '../../core-domain/identity/RedisIdentityBindingRepository.js';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const redis = new Redis(process.env["REDIS_URL"] ?? 'redis://localhost:6379');
  const repo = new RedisIdentityBindingRepository(redis);

  try {
    const now = new Date().toISOString();

    const binding: IdentityBinding = {
      canonicalAccountId: 'acct:test:1',
      contextId: 'default',
      webId: 'http://localhost:3000/alice/profile/card#me',
      activityPubActorUri: 'http://localhost:3000/alice',
      atprotoDid: 'did:plc:testalice123',
      atprotoHandle: 'alice.test',
      canonicalDidMethod: null,
      atprotoPdsEndpoint: null,
      apSigningKeyRef: 'key:ap-signing',
      atSigningKeyRef: 'key:commit',
      atRotationKeyRef: 'key:rotation',
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
      createdAt: now,
      updatedAt: now,
    };

    await repo.upsert(binding);

    const byCanonical = await repo.getByCanonicalAccountId(binding.canonicalAccountId);
    const byDid = await repo.getByDid(binding.atprotoDid!);
    const byHandle = await repo.getByHandle(binding.atprotoHandle!);

    assert(byCanonical, 'missing canonical lookup');
    assert(byDid, 'missing did lookup');
    assert(byHandle, 'missing handle lookup');

    assert(byCanonical.canonicalAccountId === binding.canonicalAccountId, 'canonical mismatch');
    assert(byDid.canonicalAccountId === binding.canonicalAccountId, 'did index mismatch');
    assert(byHandle.canonicalAccountId === binding.canonicalAccountId, 'handle index mismatch');

    console.log(
      JSON.stringify(
        {
          ok: true,
          canonicalAccountId: binding.canonicalAccountId,
        },
        null,
        2
      )
    );
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
