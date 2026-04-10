/**
 * V6 WebFinger and Actor Document Handler
 * 
 * The sidecar serves WebFinger and actor documents to enable federation discovery.
 * This was missing from earlier versions and is critical for Tier 2 compliance.
 * 
 * Endpoints:
 * - /.well-known/webfinger - WebFinger discovery
 * - /users/{username} - Actor document
 * - /users/{username}/followers - Followers collection
 * - /users/{username}/following - Following collection
 * - /users/{username}/inbox - Inbox collection (read-only from sidecar perspective)
 * - /users/{username}/outbox - Outbox collection (read-only from sidecar perspective)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface ActorDocumentConfig {
  baseUrl: string;
  activityPodsUrl: string;
  activityPodsToken: string;
}

export interface WebFingerResponse {
  subject: string;
  aliases?: string[];
  links: Array<{
    rel: string;
    type?: string;
    href?: string;
    template?: string;
  }>;
}

export interface ActorDocument {
  '@context': string[];
  type: string;
  id: string;
  preferredUsername: string;
  name?: string;
  summary?: string;
  inbox: string;
  outbox: string;
  followers: string;
  following: string;
  publicKey: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
  endpoints?: {
    sharedInbox: string;
  };
}

// ============================================================================
// WebFinger Handler
// ============================================================================

export async function handleWebFinger(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ActorDocumentConfig
): Promise<void> {
  const resource = (request.query as { resource?: string })?.resource ?? '';

  if (!resource) {
    return reply.status(400).send({
      error: 'missing_resource',
      error_description: 'resource parameter is required',
    });
  }

  // Parse resource: acct:username@domain or https://domain/users/username
  let username: string;
  let domain: string;

  if (resource.startsWith('acct:')) {
    const parts = resource.substring(5).split('@');
    if (parts.length !== 2) {
      return reply.status(400).send({
        error: 'invalid_resource',
        error_description: 'Invalid acct: format',
      });
    }
    username = parts[0]!;
    domain = parts[1]!;
  } else if (resource.startsWith('https://') || resource.startsWith('http://')) {
    try {
      const url = new URL(resource);
      domain = url.hostname;
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length < 2 || pathParts[0] !== 'users') {
        throw new Error('Invalid path');
      }
      username = pathParts[1]!;
    } catch (err) {
      return reply.status(400).send({
        error: 'invalid_resource',
        error_description: 'Invalid URL format',
      });
    }
  } else {
    return reply.status(400).send({
      error: 'invalid_resource',
      error_description: 'Resource must be acct: or https: URI',
    });
  }

  // Verify domain matches our base URL
  try {
    const baseUrlObj = new URL(config.baseUrl);
    if (domain !== baseUrlObj.hostname) {
      return reply.status(404).send({
        error: 'not_found',
        error_description: 'User not found on this server',
      });
    }
  } catch (err) {
    logger.error('Invalid base URL:', err);
    return reply.status(500).send({ error: 'server_error' });
  }

  const actorUri = `${config.baseUrl}/users/${username}`;

  const webfingerResponse: WebFingerResponse = {
    subject: `acct:${username}@${domain}`,
    aliases: [actorUri],
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: actorUri,
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `${config.baseUrl}/users/${username}/profile`,
      },
    ],
  };

  reply.type('application/jrd+json').send(webfingerResponse);
}

// ============================================================================
// Actor Document Handler
// ============================================================================

export async function handleActorDocument(
  request: FastifyRequest<{ Params: { username: string } }>,
  reply: FastifyReply,
  config: ActorDocumentConfig
): Promise<void> {
  const { username } = request.params;

  // Validate username format
  if (!username || !/^[a-zA-Z0-9._-]+$/.test(username)) {
    return reply.status(400).send({
      error: 'invalid_username',
      error_description: 'Invalid username format',
    });
  }

  try {
    // Fetch actor from ActivityPods
    const actorData = await fetchActorFromActivityPods(
      username,
      config.activityPodsUrl,
      config.activityPodsToken
    );

    if (!actorData) {
      return reply.status(404).send({
        error: 'not_found',
        error_description: 'Actor not found',
      });
    }

    const actorUri = `${config.baseUrl}/users/${username}`;

    const actorDocument: ActorDocument = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1',
      ],
      type: actorData.type || 'Person',
      id: actorUri,
      preferredUsername: username,
      name: actorData.name,
      summary: actorData.summary,
      inbox: `${actorUri}/inbox`,
      outbox: `${actorUri}/outbox`,
      followers: `${actorUri}/followers`,
      following: `${actorUri}/following`,
      publicKey: {
        id: `${actorUri}#main-key`,
        owner: actorUri,
        publicKeyPem: actorData.publicKeyPem || '',
      },
      endpoints: {
        sharedInbox: `${config.baseUrl}/inbox`,
      },
    };

    reply
      .type('application/activity+json')
      .header('Cache-Control', 'public, max-age=3600')
      .send(actorDocument);
  } catch (err) {
    logger.error('Error fetching actor document:', err);
    reply.status(500).send({ error: 'server_error' });
  }
}

// ============================================================================
// Collection Handlers
// ============================================================================

export async function handleFollowersCollection(
  request: FastifyRequest<{ Params: { username: string } }>,
  reply: FastifyReply,
  config: ActorDocumentConfig
): Promise<void> {
  const { username } = request.params;
  const actorUri = `${config.baseUrl}/users/${username}`;

  const collection = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection',
    id: `${actorUri}/followers`,
    totalItems: 0,
    first: `${actorUri}/followers?page=1`,
  };

  reply
    .type('application/activity+json')
    .header('Cache-Control', 'public, max-age=3600')
    .send(collection);
}

export async function handleFollowingCollection(
  request: FastifyRequest<{ Params: { username: string } }>,
  reply: FastifyReply,
  config: ActorDocumentConfig
): Promise<void> {
  const { username } = request.params;
  const actorUri = `${config.baseUrl}/users/${username}`;

  const collection = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection',
    id: `${actorUri}/following`,
    totalItems: 0,
    first: `${actorUri}/following?page=1`,
  };

  reply
    .type('application/activity+json')
    .header('Cache-Control', 'public, max-age=3600')
    .send(collection);
}

// ============================================================================
// Helper Functions
// ============================================================================

async function fetchActorFromActivityPods(
  username: string,
  activityPodsUrl: string,
  token: string
): Promise<any | null> {
  try {
    const response = await fetch(
      `${activityPodsUrl}/api/internal/actors/${username}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`ActivityPods returned ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    logger.error('Error fetching actor from ActivityPods:', err);
    throw err;
  }
}

/**
 * Register WebFinger and actor handlers with Fastify
 */
export async function registerWebFingerHandlers(
  fastify: FastifyInstance,
  config: ActorDocumentConfig
): Promise<void> {
  fastify.get('/.well-known/webfinger', async (request, reply) => {
    await handleWebFinger(request, reply, config);
  });

  fastify.get('/users/:username', async (request, reply) => {
    await handleActorDocument(request as FastifyRequest<{ Params: { username: string } }>, reply, config);
  });

  fastify.get('/users/:username/followers', async (request, reply) => {
    await handleFollowersCollection(request as FastifyRequest<{ Params: { username: string } }>, reply, config);
  });

  fastify.get('/users/:username/following', async (request, reply) => {
    await handleFollowingCollection(request as FastifyRequest<{ Params: { username: string } }>, reply, config);
  });

  logger.info('WebFinger and actor handlers registered');
}
