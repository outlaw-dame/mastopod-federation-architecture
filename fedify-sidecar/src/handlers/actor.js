import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Actor handler for serving actor documents
 * Proxies to ActivityPods with proper content negotiation
 */
class ActorHandler {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 60000; // 1 minute cache for actor documents
  }

  /**
   * Handle actor document requests
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async handleActorRequest(req, res) {
    const { username } = req.params;
    const accept = req.headers['accept'] || '';

    // Check if this is an ActivityPub request
    const isActivityPub = accept.includes('application/activity+json') ||
                          accept.includes('application/ld+json');

    if (!isActivityPub) {
      // Redirect to frontend for HTML requests
      return res.redirect(`${config.activityPodsUrl}/users/${username}`);
    }

    try {
      // Check cache
      const cacheKey = `actor:${username}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        res.set('Content-Type', 'application/activity+json');
        return res.json(cached.data);
      }

      // Fetch from ActivityPods
      const response = await fetch(
        `${config.activityPodsUrl}/users/${username}`,
        {
          headers: {
            'Accept': 'application/activity+json',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return res.status(404).json({ error: 'Actor not found' });
        }
        throw new Error(`ActivityPods returned ${response.status}`);
      }

      const actor = await response.json();

      // Ensure the actor has required federation endpoints
      const actorWithEndpoints = this.ensureEndpoints(actor, username);

      // Cache the result
      this.cache.set(cacheKey, {
        data: actorWithEndpoints,
        timestamp: Date.now(),
      });

      res.set('Content-Type', 'application/activity+json');
      res.json(actorWithEndpoints);

      logger.debug(`Actor request for ${username}`);
    } catch (err) {
      logger.error('Actor request error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Ensure actor has all required endpoints
   * @param {Object} actor - The actor document
   * @param {string} username - The username
   * @returns {Object} - Actor with endpoints
   */
  ensureEndpoints(actor, username) {
    const baseUrl = config.baseUrl;

    // Ensure inbox and outbox are present
    if (!actor.inbox) {
      actor.inbox = `${baseUrl}/users/${username}/inbox`;
    }
    if (!actor.outbox) {
      actor.outbox = `${baseUrl}/users/${username}/outbox`;
    }

    // Ensure followers and following collections
    if (!actor.followers) {
      actor.followers = `${baseUrl}/users/${username}/followers`;
    }
    if (!actor.following) {
      actor.following = `${baseUrl}/users/${username}/following`;
    }

    // Ensure endpoints object
    if (!actor.endpoints) {
      actor.endpoints = {};
    }

    // Add shared inbox for efficiency
    if (!actor.endpoints.sharedInbox) {
      actor.endpoints.sharedInbox = `${baseUrl}/inbox`;
    }

    return actor;
  }

  /**
   * Handle outbox requests (GET)
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async handleOutboxRequest(req, res) {
    const { username } = req.params;

    try {
      // Forward to ActivityPods
      const response = await fetch(
        `${config.activityPodsUrl}/users/${username}/outbox`,
        {
          headers: {
            'Accept': 'application/activity+json',
            // Forward authentication if present
            ...(req.headers['authorization'] && {
              'Authorization': req.headers['authorization'],
            }),
          },
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: response.statusText });
      }

      const outbox = await response.json();

      res.set('Content-Type', 'application/activity+json');
      res.json(outbox);
    } catch (err) {
      logger.error('Outbox request error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Handle followers collection requests
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async handleFollowersRequest(req, res) {
    const { username } = req.params;

    try {
      const response = await fetch(
        `${config.activityPodsUrl}/users/${username}/followers`,
        {
          headers: {
            'Accept': 'application/activity+json',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: response.statusText });
      }

      const followers = await response.json();

      res.set('Content-Type', 'application/activity+json');
      res.json(followers);
    } catch (err) {
      logger.error('Followers request error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Handle following collection requests
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async handleFollowingRequest(req, res) {
    const { username } = req.params;

    try {
      const response = await fetch(
        `${config.activityPodsUrl}/users/${username}/following`,
        {
          headers: {
            'Accept': 'application/activity+json',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: response.statusText });
      }

      const following = await response.json();

      res.set('Content-Type', 'application/activity+json');
      res.json(following);
    } catch (err) {
      logger.error('Following request error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('Actor cache cleared');
  }
}

export const actorHandler = new ActorHandler();
export default actorHandler;
