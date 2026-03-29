import type { FastifyInstance } from 'fastify';
import type { OAuthAuthorizationServer } from './OAuthTypes.js';

export function registerProtectedResourceMetadataRoute(
  app: FastifyInstance,
  authorizationServer: OAuthAuthorizationServer,
): void {
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    return reply.status(200).send(authorizationServer.getProtectedResourceMetadata());
  });
}
