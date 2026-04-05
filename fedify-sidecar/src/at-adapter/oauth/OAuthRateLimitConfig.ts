import {
  DEFAULT_OAUTH_ROUTE_LIMITS,
  type OAuthRouteRateLimitPolicy,
  type OAuthRouteRateLimits,
} from './OAuthRouteHandlers.js';

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

type EndpointKey = keyof OAuthRouteRateLimits;

const ENDPOINT_ENV_PREFIX: Record<EndpointKey, string> = {
  par: 'AT_OAUTH_RATE_LIMIT_PAR',
  authorizeGet: 'AT_OAUTH_RATE_LIMIT_AUTHORIZE_GET',
  authorizePost: 'AT_OAUTH_RATE_LIMIT_AUTHORIZE_POST',
  token: 'AT_OAUTH_RATE_LIMIT_TOKEN',
  externalDiscover: 'AT_OAUTH_RATE_LIMIT_EXTERNAL_DISCOVER',
};

function parseIntEnv(
  env: EnvMap,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw == null || raw === '') return fallback;

  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${key} must be a positive integer`);
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }

  return parsed;
}

function parsePolicyForEndpoint(
  env: EnvMap,
  endpoint: EndpointKey,
  defaults: OAuthRouteRateLimitPolicy,
): OAuthRouteRateLimitPolicy {
  const prefix = ENDPOINT_ENV_PREFIX[endpoint];

  return {
    windowSec: parseIntEnv(env, `${prefix}_WINDOW_SEC`, defaults.windowSec, 1, 3600),
    perIpLimit: parseIntEnv(env, `${prefix}_PER_IP`, defaults.perIpLimit, 1, 100000),
    perDimensionLimit: parseIntEnv(
      env,
      `${prefix}_PER_DIMENSION`,
      defaults.perDimensionLimit,
      1,
      100000,
    ),
    perIpDimensionLimit: parseIntEnv(
      env,
      `${prefix}_PER_IP_DIMENSION`,
      defaults.perIpDimensionLimit,
      1,
      100000,
    ),
  };
}

export function parseOAuthRouteRateLimitsFromEnv(
  env: EnvMap,
  base: OAuthRouteRateLimits = DEFAULT_OAUTH_ROUTE_LIMITS,
): OAuthRouteRateLimits {
  return {
    par: parsePolicyForEndpoint(env, 'par', base.par),
    authorizeGet: parsePolicyForEndpoint(env, 'authorizeGet', base.authorizeGet),
    authorizePost: parsePolicyForEndpoint(env, 'authorizePost', base.authorizePost),
    token: parsePolicyForEndpoint(env, 'token', base.token),
    externalDiscover: parsePolicyForEndpoint(env, 'externalDiscover', base.externalDiscover),
  };
}
