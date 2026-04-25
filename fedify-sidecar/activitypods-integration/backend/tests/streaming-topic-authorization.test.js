import { describe, expect, test, vi } from 'vitest';
import serviceDefinition from '../services/streaming-topic-authorization.service.js';

function createService(overrides = {}) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    ...serviceDefinition.methods,
    ...overrides
  };
}

describe('streaming-topic-authorization', () => {
  test('allows phase 1, exact URI, and bounded wildcard topics', async () => {
    const service = createService();
    const ctx = {
      params: {
        principal: 'https://example.com/users/alice',
        topics: [
          'feeds/public/local',
          'feeds/local',
          'server.example/note/123',
          'server.example/note/#'
        ]
      },
      meta: {}
    };

    const result = await serviceDefinition.actions.authorizeTopics.call(service, ctx);

    expect(result).toEqual({
      allowedTopics: [
        'feeds/local',
        'feeds/public/local',
        'server.example/note/#',
        'server.example/note/123'
      ],
      deniedTopics: []
    });
  });

  test('denies overly broad and unsupported topics', async () => {
    const service = createService();
    const ctx = {
      params: {
        principal: 'https://example.com/users/alice',
        topics: [
          '#',
          'server.example/#',
          'server.example/#/extra'
        ]
      },
      meta: {}
    };

    const result = await serviceDefinition.actions.authorizeTopics.call(service, ctx);

    expect(result.allowedTopics).toEqual([]);
    expect(result.deniedTopics).toEqual([
      expect.objectContaining({ topic: '#', reasonCode: 'unsupported_topic' }),
      expect.objectContaining({ topic: 'server.example/#', reasonCode: 'wildcard_scope_too_broad' }),
      expect.objectContaining({ topic: 'server.example/#/extra', reasonCode: 'unsupported_topic' })
    ]);
  });
});
