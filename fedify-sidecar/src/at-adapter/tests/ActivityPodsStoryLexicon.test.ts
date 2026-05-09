import { describe, expect, it } from 'vitest';

import {
  ACTIVITYPODS_STORY_COLLECTION,
  normalizeActivityPodsStoryRecord,
} from '../lexicon/ActivityPodsStoryLexicon.js';

describe('ActivityPods story lexicon', () => {
  it('defaults active stories to a 24 hour expiry', () => {
    const createdAt = '2026-05-08T12:00:00.000Z';

    const story = normalizeActivityPodsStoryRecord({
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt,
      media: {
        kind: 'image',
        blob: {
          $type: 'blob',
          ref: { $link: 'bafkreistoryimagecid0002' },
          mimeType: 'image/png',
          size: 4096,
        },
        alt: 'A story image with useful alt text',
      },
    }, { now: createdAt, requireActive: true });

    expect(story).toMatchObject({
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt,
      expiresAt: '2026-05-09T12:00:00.000Z',
      visibility: 'public',
      allowReplies: true,
    });
  });

  it('rejects stories that outlive the 24 hour window', () => {
    const createdAt = '2026-05-08T12:00:00.000Z';

    const story = normalizeActivityPodsStoryRecord({
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt,
      expiresAt: '2026-05-10T12:00:00.000Z',
      media: {
        kind: 'video',
        blob: {
          ref: { $link: 'bafkreistoryvideocid0002' },
          mimeType: 'video/mp4',
          size: 8192,
        },
        alt: 'A short story video',
        durationMs: 15_000,
      },
    }, { now: createdAt, requireActive: true });

    expect(story).toBeNull();
  });

  it('rejects stories created beyond the allowed clock skew', () => {
    const story = normalizeActivityPodsStoryRecord({
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt: '2026-05-08T12:06:00.000Z',
      expiresAt: '2026-05-08T18:00:00.000Z',
      media: {
        kind: 'image',
        blob: {
          ref: { $link: 'bafkreistoryfuturecid0002' },
          mimeType: 'image/png',
          size: 8192,
        },
        alt: 'A future-dated story image',
      },
    }, { now: '2026-05-08T12:00:00.000Z', requireActive: true });

    expect(story).toBeNull();
  });

  it('rejects non-http story links and more than four links', () => {
    const createdAt = '2026-05-08T12:00:00.000Z';

    const unsafeLink = normalizeActivityPodsStoryRecord({
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt,
      media: {
        kind: 'image',
        blob: {
          ref: { $link: 'bafkreistorylinkcid0002' },
          mimeType: 'image/png',
          size: 8192,
        },
        alt: 'A story image with a bad link',
      },
      links: [{ uri: 'javascript:alert(1)', title: 'bad' }],
    }, { now: createdAt, requireActive: true });

    const tooManyLinks = normalizeActivityPodsStoryRecord({
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt,
      media: {
        kind: 'image',
        blob: {
          ref: { $link: 'bafkreistorytoomanylinks02' },
          mimeType: 'image/png',
          size: 8192,
        },
        alt: 'A story image with too many links',
      },
      links: [
        { uri: 'https://example.com/1' },
        { uri: 'https://example.com/2' },
        { uri: 'https://example.com/3' },
        { uri: 'https://example.com/4' },
        { uri: 'https://example.com/5' },
      ],
    }, { now: createdAt, requireActive: true });

    expect(unsafeLink).toBeNull();
    expect(tooManyLinks).toBeNull();
  });

  it('requires media alt text and matching media MIME types', () => {
    const story = normalizeActivityPodsStoryRecord({
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt: '2026-05-08T12:00:00.000Z',
      media: {
        kind: 'image',
        blob: {
          ref: { $link: 'bafkreistorybadcid000002' },
          mimeType: 'video/mp4',
          size: 8192,
        },
      },
    }, { now: '2026-05-08T12:00:00.000Z', requireActive: true });

    expect(story).toBeNull();
  });
});
