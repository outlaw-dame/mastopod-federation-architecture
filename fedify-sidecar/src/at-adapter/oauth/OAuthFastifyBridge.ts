import type { FastifyInstance } from 'fastify';
import { registerOAuthRouteHandlers } from './OAuthRouteHandlers.js';
import type { OAuthRouteRateLimits } from './OAuthRouteHandlers.js';
import { DpopVerifier } from './DpopVerifier.js';
import type { OAuthAuthorizationServer } from './OAuthTypes.js';
import type { AtSessionService } from '../auth/AtSessionTypes.js';
import type { OAuthExternalDiscoveryBroker } from './OAuthExternalDiscoveryBroker.js';
import type { OAuthConsentChallengeStore, OAuthRateLimitStore } from './OAuthRedisStores.js';

export interface OAuthFastifyBridgeOptions {
  authorizationServer: OAuthAuthorizationServer;
  dpopVerifier: DpopVerifier;
  sessionService?: AtSessionService;
  externalDiscoveryBroker?: OAuthExternalDiscoveryBroker;
  consentChallengeStore?: OAuthConsentChallengeStore;
  rateLimitStore?: OAuthRateLimitStore;
  rateLimits?: Partial<OAuthRouteRateLimits>;
}

export function registerOAuthRoutes(app: FastifyInstance, opts: OAuthFastifyBridgeOptions): void {
  registerOAuthRouteHandlers(app, {
    authorizationServer: opts.authorizationServer,
    dpopVerifier: opts.dpopVerifier,
    sessionService: opts.sessionService,
    externalDiscoveryBroker: opts.externalDiscoveryBroker,
    consentChallengeStore: opts.consentChallengeStore,
    rateLimitStore: opts.rateLimitStore,
    rateLimits: opts.rateLimits,
  });
}
