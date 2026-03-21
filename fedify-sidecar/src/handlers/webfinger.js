import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * WebFinger handler for actor discovery
 * Proxies requests to ActivityPods with caching
 */
class WebFingerHandler {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 300000; // 5 minutes
  }

  /**
   * Handle WebFinger requests
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async handleWebFinger(req, res) {
    const resource = req.query.resource;

    if (!resource) {
      return res.status(400).json({ error: 'Missing resource parameter' });
    }

    try {
      // Check cache
      const cached = this.cache.get(resource);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        res.set('Content-Type', 'application/jrd+json');
        return res.json(cached.data);
      }

      // Forward to ActivityPods
      const response = await fetch(
        `${config.activityPodsUrl}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
        {
          headers: {
            'Accept': 'application/jrd+json',
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return res.status(404).json({ error: 'Resource not found' });
        }
        throw new Error(`ActivityPods returned ${response.status}`);
      }

      const data = await response.json();

      // Update links to point to sidecar for federation endpoints
      if (data.links) {
        data.links = data.links.map(link => {
          if (link.rel === 'self' && link.type === 'application/activity+json') {
            // Keep the original link, federation will be handled by routing
            return link;
          }
          return link;
        });
      }

      // Cache the result
      this.cache.set(resource, {
        data,
        timestamp: Date.now(),
      });

      res.set('Content-Type', 'application/jrd+json');
      res.json(data);

      logger.debug(`WebFinger lookup for ${resource}`);
    } catch (err) {
      logger.error('WebFinger error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('WebFinger cache cleared');
  }
}

export const webFingerHandler = new WebFingerHandler();
export default webFingerHandler;
