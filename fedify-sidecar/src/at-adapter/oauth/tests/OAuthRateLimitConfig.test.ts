import { describe, expect, it } from 'vitest';

import { DEFAULT_OAUTH_ROUTE_LIMITS } from '../OAuthRouteHandlers.js';
import { parseOAuthRouteRateLimitsFromEnv } from '../OAuthRateLimitConfig.js';

describe('OAuth rate-limit env parsing', () => {
  it('uses canonical defaults when env vars are not set', () => {
    const parsed = parseOAuthRouteRateLimitsFromEnv({});
    expect(parsed).toEqual(DEFAULT_OAUTH_ROUTE_LIMITS);
  });

  it('overrides configured values from valid env vars', () => {
    const parsed = parseOAuthRouteRateLimitsFromEnv({
      AT_OAUTH_RATE_LIMIT_TOKEN_WINDOW_SEC: '120',
      AT_OAUTH_RATE_LIMIT_TOKEN_PER_IP: '321',
      AT_OAUTH_RATE_LIMIT_TOKEN_PER_DIMENSION: '654',
      AT_OAUTH_RATE_LIMIT_TOKEN_PER_IP_DIMENSION: '111',
    });

    expect(parsed.token).toEqual({
      windowSec: 120,
      perIpLimit: 321,
      perDimensionLimit: 654,
      perIpDimensionLimit: 111,
    });
    expect(parsed.par).toEqual(DEFAULT_OAUTH_ROUTE_LIMITS.par);
  });

  it('throws on malformed or out-of-range env values', () => {
    expect(() =>
      parseOAuthRouteRateLimitsFromEnv({
        AT_OAUTH_RATE_LIMIT_EXTERNAL_DISCOVER_PER_IP: 'not-a-number',
      }),
    ).toThrow(/AT_OAUTH_RATE_LIMIT_EXTERNAL_DISCOVER_PER_IP must be a positive integer/);

    expect(() =>
      parseOAuthRouteRateLimitsFromEnv({
        AT_OAUTH_RATE_LIMIT_EXTERNAL_DISCOVER_WINDOW_SEC: '0',
      }),
    ).toThrow(/AT_OAUTH_RATE_LIMIT_EXTERNAL_DISCOVER_WINDOW_SEC must be between 1 and 3600/);
  });
});
