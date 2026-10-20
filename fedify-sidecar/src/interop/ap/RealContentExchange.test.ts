import { describe, expect, it } from 'vitest';
// @ts-expect-error proof scripts are plain Node modules
import { assertInboundContent, inboundContentQuery, poll, validateContentOrigin } from '../../../interop/ap/scripts/prove-mastodon-content-exchange.mjs';

const origin = { ok: true, mode: 'native', senderUsername: 'alice', actorUri: 'https://activitypods/alice',
  senderOutbox: 'https://activitypods/alice/outbox', remoteActorUri: 'https://mastodon/users/interop' };
const rows = [{ activity: { value: 'https://mastodon/users/interop/statuses/1/activity' },
  actor: { value: origin.remoteActorUri }, object: { value: 'https://mastodon/users/interop/statuses/1' },
  content: { value: '<p>unique-proof-marker</p>' } }];

describe('real content exchange evidence', () => {
  it('queries inbox membership and the pinned SemApps inline-object snapshot representation', () => {
    const query = inboundContentQuery(origin.senderOutbox.replace('outbox', 'inbox'), origin.remoteActorUri, rows[0]!.object.value);
    expect(query).toContain('as:items ?activity');
    expect(query).toContain('?storedObject as:current ?object');
    expect(query).toContain('?storedObject as:attributedTo');
    expect(() => inboundContentQuery('https://activitypods/inbox>bad', origin.remoteActorUri, rows[0]!.object.value)).toThrow();
  });
  it('accepts exact remote actor, object, and persisted content', () => {
    expect(assertInboundContent(rows, origin.remoteActorUri, rows[0]!.object.value, 'unique-proof-marker')).toBe(rows[0]!.activity.value);
  });
  it('rejects empty, duplicate, and mismatched persisted results', () => {
    for (const invalid of [[], [...rows, ...rows], [{ ...rows[0], actor: { value: origin.actorUri } }],
      [{ ...rows[0], object: { value: 'https://mastodon/wrong' } }],
      [{ ...rows[0], content: { value: 'unrelated content' } }]]) {
      expect(() => assertInboundContent(invalid, origin.remoteActorUri, rows[0]!.object.value, 'unique-proof-marker')).toThrow();
    }
  });
  it('restricts publishing to the isolated fixture and exact outbox authority', () => {
    expect(validateContentOrigin(origin)).toBe(origin);
    for (const invalid of [{ ...origin, senderOutbox: 'https://evil.test/outbox' },
      { ...origin, remoteActorUri: 'https://mastodon.social/users/someone' },
      { ...origin, senderUsername: '../settings' }, { ...origin, actorUri: 'https://activitypods/alice>bad' }]) {
      expect(() => validateContentOrigin(invalid)).toThrow();
    }
  });
  it('polls with capped backoff and fails when persistence never appears', async () => {
    const delays: number[] = [];
    await expect(poll(async () => false, { attempts: 4, delay: async (ms: number) => { delays.push(ms); } })).rejects.toThrow();
    expect(delays).toEqual([500, 1000, 2000]);
  });
  it('does not reinterpret a query failure as success', async () => {
    await expect(poll(async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
  });
});
