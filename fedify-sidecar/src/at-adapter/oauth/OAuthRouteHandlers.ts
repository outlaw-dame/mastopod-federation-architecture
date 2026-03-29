import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { OAuthAuthorizationServer } from './OAuthTypes.js';
import { DpopVerifier } from './DpopVerifier.js';
import type { AtSessionService } from '../auth/AtSessionTypes.js';
import {
  ensureNonEmptyString,
  OAuthError,
  writeOAuthError,
} from './OAuthErrors.js';
import type { OAuthExternalDiscoveryBroker } from './OAuthExternalDiscoveryBroker.js';
import type { OAuthConsentChallengeStore, OAuthRateLimitStore } from './OAuthRedisStores.js';
import { incrementOAuthSecurityMetric } from './OAuthSecurityMetrics.js';

interface OAuthRouteHandlersOptions {
  authorizationServer: OAuthAuthorizationServer;
  dpopVerifier: DpopVerifier;
  sessionService?: AtSessionService;
  externalDiscoveryBroker?: OAuthExternalDiscoveryBroker;
  consentChallengeStore?: OAuthConsentChallengeStore;
  rateLimitStore?: OAuthRateLimitStore;
  rateLimits?: Partial<OAuthRouteRateLimits>;
}

export interface OAuthRouteRateLimitPolicy {
  windowSec: number;
  perIpLimit: number;
  perDimensionLimit: number;
  perIpDimensionLimit: number;
}

export interface OAuthRouteRateLimits {
  par: OAuthRouteRateLimitPolicy;
  authorizeGet: OAuthRouteRateLimitPolicy;
  authorizePost: OAuthRouteRateLimitPolicy;
  token: OAuthRouteRateLimitPolicy;
  externalDiscover: OAuthRouteRateLimitPolicy;
}

export const DEFAULT_OAUTH_ROUTE_LIMITS: OAuthRouteRateLimits = {
  par: { windowSec: 60, perIpLimit: 90, perDimensionLimit: 120, perIpDimensionLimit: 60 },
  authorizeGet: { windowSec: 60, perIpLimit: 120, perDimensionLimit: 150, perIpDimensionLimit: 90 },
  authorizePost: { windowSec: 60, perIpLimit: 60, perDimensionLimit: 75, perIpDimensionLimit: 45 },
  token: { windowSec: 60, perIpLimit: 90, perDimensionLimit: 120, perIpDimensionLimit: 60 },
  externalDiscover: { windowSec: 60, perIpLimit: 45, perDimensionLimit: 60, perIpDimensionLimit: 30 },
};

function fullRequestUrl(req: FastifyRequest): string {
  const host = req.headers.host ?? 'localhost';
  return `${req.protocol}://${host}${req.url.split('?')[0]}`;
}

export function registerOAuthRouteHandlers(app: FastifyInstance, opts: OAuthRouteHandlersOptions): void {
  const {
    authorizationServer,
    dpopVerifier,
    sessionService,
    externalDiscoveryBroker,
    consentChallengeStore,
    rateLimitStore,
    rateLimits,
  } = opts;
  const activeRateLimits: OAuthRouteRateLimits = {
    ...DEFAULT_OAUTH_ROUTE_LIMITS,
    ...rateLimits,
  };

  function toHash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  }

  function requestFingerprint(req: FastifyRequest): string {
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    const input = `${req.ip}|${userAgent}`;
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  function audit(
    req: FastifyRequest,
    event: string,
    outcome: 'success' | 'denied' | 'failure',
    details: Record<string, unknown> = {},
  ): void {
    incrementOAuthSecurityMetric({ event, outcome });
    req.log.info(
      {
        oauthAudit: {
          event,
          outcome,
          requestId: req.id,
          method: req.method,
          route: req.routeOptions.url,
          ipHash: toHash(req.ip || ''),
          userAgentHash: toHash(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''),
          ...details,
        },
      },
      'oauth_security_event',
    );
  }

  async function enforceRateLimit(
    req: FastifyRequest,
    reply: FastifyReply,
    endpoint: keyof OAuthRouteRateLimits,
    dimension: string,
  ): Promise<boolean> {
    if (!rateLimitStore) {
      return true;
    }

    const policy = activeRateLimits[endpoint];
    const ipHash = toHash(req.ip || '');
    const dimensionHash = toHash(dimension);
    const buckets = [
      { key: `${endpoint}:ip:${ipHash}`, limit: policy.perIpLimit },
      { key: `${endpoint}:dim:${dimensionHash}`, limit: policy.perDimensionLimit },
      { key: `${endpoint}:ipdim:${ipHash}:${dimensionHash}`, limit: policy.perIpDimensionLimit },
    ];

    try {
      let maxRetryAfter = 1;
      for (const bucket of buckets) {
        const result = await rateLimitStore.consume(bucket.key, bucket.limit, policy.windowSec);
        if (!result.allowed) {
          maxRetryAfter = Math.max(maxRetryAfter, result.retryAfterSec);
          reply.header('Retry-After', String(maxRetryAfter));
          audit(req, 'ratelimit.block', 'denied', {
            endpoint,
            bucket: bucket.key.split(':')[1],
            limit: result.limit,
            count: result.count,
            retryAfterSec: result.retryAfterSec,
          });
          writeOAuthError(
            reply,
            new OAuthError('temporarily_unavailable', 429, 'Too many requests'),
          );
          return false;
        }
      }

      return true;
    } catch (error) {
      audit(req, 'ratelimit.error', 'failure', {
        endpoint,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      writeOAuthError(
        reply,
        new OAuthError('temporarily_unavailable', 503, 'Rate limiter unavailable'),
      );
      return false;
    }
  }

  async function verifyDpopWithNonce(
    req: FastifyRequest,
    reply: FastifyReply,
    method: string,
    htu: string,
  ): Promise<string | null> {
    const dpopHeader = req.headers['dpop'];
    const nonce = await authorizationServer.mintDpopNonce();

    if (typeof dpopHeader !== 'string' || !dpopHeader.trim()) {
      writeOAuthError(
        reply,
        new OAuthError('use_dpop_nonce', 401, 'DPoP proof is required'),
        'use_dpop_nonce',
        401,
        nonce,
      );
      return null;
    }

    try {
      const proof = await dpopVerifier.verify({
        proofJwt: dpopHeader,
        htm: method,
        htu,
        nonce,
      });
      return proof.jkt;
    } catch (error) {
      writeOAuthError(
        reply,
        new OAuthError('use_dpop_nonce', 401, 'DPoP proof nonce mismatch or invalid proof'),
        'use_dpop_nonce',
        401,
        nonce,
      );
      return null;
    }
  }

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    return reply.status(200).send(authorizationServer.getAuthorizationServerMetadata());
  });

  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    return reply.status(200).send(authorizationServer.getProtectedResourceMetadata());
  });

  app.post('/oauth/par', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dimension = typeof body['client_id'] === 'string' ? body['client_id'] : req.ip;
    if (!(await enforceRateLimit(req, reply, 'par', dimension))) return;

    const dpopJkt = await verifyDpopWithNonce(req, reply, 'POST', fullRequestUrl(req));
    if (!dpopJkt) return;

    try {
      const clientId = ensureNonEmptyString(body['client_id'], 2048, 'client_id');
      const redirectUri = ensureNonEmptyString(body['redirect_uri'], 2048, 'redirect_uri');
      const scope = ensureNonEmptyString(body['scope'], 1024, 'scope');
      const codeChallenge = ensureNonEmptyString(body['code_challenge'], 256, 'code_challenge');

      const result = await authorizationServer.createPushedAuthorizationRequest(
        {
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope,
          state: typeof body['state'] === 'string' ? body['state'] : undefined,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        },
        dpopJkt,
      );

      audit(req, 'oauth.par.create', 'success', {
        clientIdHash: toHash(clientId),
        scopeHash: toHash(scope),
      });

      return reply.status(201).send(result);
    } catch (error) {
      audit(req, 'oauth.par.create', 'failure', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return writeOAuthError(reply, error, 'invalid_request', 400);
    }
  });

  app.get('/oauth/authorize', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, unknown>;
    const dimension = typeof query['request_uri'] === 'string' ? query['request_uri'] : req.ip;
    if (!(await enforceRateLimit(req, reply, 'authorizeGet', dimension))) return;

    try {
      const requestUri = ensureNonEmptyString(query['request_uri'], 4096, 'request_uri');

      const context = await authorizationServer.getAuthorizationContext(requestUri);
      if (!context) {
        throw new OAuthError('invalid_request', 400, 'request_uri is invalid or expired');
      }

      if (!consentChallengeStore) {
        throw new OAuthError('server_error', 500, 'Consent challenge store is not configured');
      }

      const now = Math.floor(Date.now() / 1000);
      const ttlSec = Math.max(30, Math.min(300, context.expiresAtEpochSec - now));
      const challenge = await consentChallengeStore.mint(
        requestUri,
        requestFingerprint(req),
        ttlSec,
      );

      audit(req, 'oauth.authorize.context', 'success', {
        clientIdHash: toHash(context.clientId),
        requestUriHash: toHash(requestUri),
      });

      return reply.status(200).send({
        consent_required: true,
        request_uri: context.requestUri,
        client_id: context.clientId,
        scope: context.scope,
        expires_at_epoch_sec: context.expiresAtEpochSec,
        consent_challenge: challenge.challengeId,
        authorize_endpoint: '/oauth/authorize',
      });
    } catch (error) {
      audit(req, 'oauth.authorize.context', 'failure', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return writeOAuthError(reply, error, 'access_denied', 400);
    }
  });

  app.post('/oauth/authorize', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dimension = typeof body['request_uri'] === 'string' ? body['request_uri'] : req.ip;
    if (!(await enforceRateLimit(req, reply, 'authorizePost', dimension))) return;

    try {
      const requestUri = ensureNonEmptyString(body['request_uri'], 4096, 'request_uri');
      const consentChallenge = ensureNonEmptyString(body['consent_challenge'], 128, 'consent_challenge');
      const decision = ensureNonEmptyString(body['decision'], 16, 'decision').toLowerCase();

      if (decision !== 'approve' && decision !== 'deny') {
        throw new OAuthError('invalid_request', 400, 'decision must be approve or deny');
      }

      if (!consentChallengeStore) {
        throw new OAuthError('server_error', 500, 'Consent challenge store is not configured');
      }

      const challengeRecord = await consentChallengeStore.consume(consentChallenge);
      if (!challengeRecord) {
        throw new OAuthError('access_denied', 400, 'consent challenge is invalid or expired');
      }

      if (challengeRecord.requestUri !== requestUri) {
        throw new OAuthError('access_denied', 400, 'consent challenge request mismatch');
      }

      if (challengeRecord.fingerprint !== requestFingerprint(req)) {
        throw new OAuthError('access_denied', 400, 'consent challenge fingerprint mismatch');
      }

      if (decision === 'deny') {
        const denied = await authorizationServer.reject(requestUri);
        const deniedRedirect = new URL(denied.redirectUri);
        deniedRedirect.searchParams.set('error', 'access_denied');
        if (denied.state) {
          deniedRedirect.searchParams.set('state', denied.state);
        }
        audit(req, 'oauth.authorize.decision', 'denied', {
          decision,
          requestUriHash: toHash(requestUri),
        });
        return reply.redirect(deniedRedirect.toString(), 302);
      }

      if (!sessionService) {
        throw new OAuthError('server_error', 500, 'Authorization user session service is not configured');
      }

      const authHeader = typeof req.headers.authorization === 'string'
        ? req.headers.authorization
        : '';
      const accessToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
      if (!accessToken) {
        throw new OAuthError('access_denied', 401, 'Authenticated user session is required to approve authorization');
      }

      const session = await sessionService.verifyAccessToken(accessToken);
      if (!session) {
        throw new OAuthError('access_denied', 401, 'Authenticated user session is invalid or expired');
      }

      const result = await authorizationServer.authorize({
        requestUri,
        subjectDid: session.did,
        canonicalAccountId: session.canonicalAccountId,
      });

      const redirect = new URL(result.redirectUri);
      redirect.searchParams.set('code', result.code);
      if (result.state) {
        redirect.searchParams.set('state', result.state);
      }
      audit(req, 'oauth.authorize.decision', 'success', {
        decision,
        requestUriHash: toHash(requestUri),
        subjectDidHash: toHash(session.did),
      });
      return reply.redirect(redirect.toString(), 302);
    } catch (error) {
      audit(req, 'oauth.authorize.decision', 'failure', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return writeOAuthError(reply, error, 'access_denied', 400);
    }
  });

  app.post('/oauth/token', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dimension = typeof body['client_id'] === 'string' ? body['client_id'] : req.ip;
    if (!(await enforceRateLimit(req, reply, 'token', dimension))) return;

    const dpopJkt = await verifyDpopWithNonce(req, reply, 'POST', fullRequestUrl(req));
    if (!dpopJkt) return;

    try {
      const grantType = body['grant_type'] === 'refresh_token'
        ? 'refresh_token'
        : 'authorization_code';
      const clientId = ensureNonEmptyString(body['client_id'], 2048, 'client_id');

      const result = await authorizationServer.exchangeToken(
        {
          grant_type: grantType,
          client_id: clientId,
          redirect_uri: typeof body['redirect_uri'] === 'string' ? body['redirect_uri'] : undefined,
          code: typeof body['code'] === 'string' ? body['code'] : undefined,
          code_verifier: typeof body['code_verifier'] === 'string' ? body['code_verifier'] : undefined,
          refresh_token: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : undefined,
        },
        dpopJkt,
      );
      audit(req, 'oauth.token.exchange', 'success', {
        grantType,
        clientIdHash: toHash(clientId),
      });
      return reply.status(200).send(result);
    } catch (error) {
      audit(req, 'oauth.token.exchange', 'failure', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return writeOAuthError(reply, error, 'invalid_grant', 400);
    }
  });

  app.post('/oauth/external/discover', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!externalDiscoveryBroker) {
      return writeOAuthError(
        reply,
        new OAuthError('temporarily_unavailable', 503, 'External discovery broker is not configured'),
      );
    }

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const identifier = ensureNonEmptyString(body['identifier'], 320, 'identifier');

      if (!(await enforceRateLimit(req, reply, 'externalDiscover', identifier))) return;

      const result = await externalDiscoveryBroker.discover(identifier);
      audit(req, 'oauth.external.discover', 'success', {
        identifierHash: toHash(identifier),
      });
      return reply.status(200).send(result);
    } catch (error) {
      audit(req, 'oauth.external.discover', 'failure', {
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return writeOAuthError(reply, error, 'invalid_request', 400);
    }
  });
}
