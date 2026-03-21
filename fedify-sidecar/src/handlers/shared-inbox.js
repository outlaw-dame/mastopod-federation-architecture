import config from '../config/index.js';
import logger from '../utils/logger.js';
import redisService from '../services/redis.js';
import inboxHandler from './inbox.js';

/**
 * Shared inbox handler for efficient activity delivery
 * Implements the ActivityPub shared inbox pattern
 */
class SharedInboxHandler {
  constructor() {
    // Statistics for monitoring
    this.stats = {
      received: 0,
      processed: 0,
      errors: 0,
    };
  }

  /**
   * Handle POST to shared inbox
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async handleSharedInboxPost(req, res) {
    const activity = req.body;
    this.stats.received++;

    try {
      // Extract actor from the activity
      const actorUri = typeof activity.actor === 'string'
        ? activity.actor
        : activity.actor?.id || activity.actor?.['@id'];

      if (!actorUri) {
        logger.warn('Shared inbox: Activity missing actor');
        return res.status(400).json({ error: 'Activity must have an actor' });
      }

      // Check if domain is blocked
      const actorDomain = new URL(actorUri).hostname;
      if (inboxHandler.blockedDomains.has(actorDomain)) {
        logger.info(`Shared inbox: Rejecting activity from blocked domain: ${actorDomain}`);
        return res.status(403).json({ error: 'Domain is blocked' });
      }

      // Verify HTTP signature
      const signatureValid = await inboxHandler.verifySignature(req, actorUri);
      if (!signatureValid) {
        logger.warn(`Shared inbox: Invalid signature for activity from ${actorUri}`);
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Deduplicate by activity ID
      const activityId = activity.id || activity['@id'];
      if (activityId) {
        const dedupeKey = `shared:dedupe:${activityId}`;
        const isNew = await redisService.setNX(dedupeKey, 86400);
        if (!isNew) {
          logger.debug(`Shared inbox: Skipping duplicate activity: ${activityId}`);
          return res.status(202).json({ status: 'already processed' });
        }
      }

      // Determine recipients
      const recipients = this.extractRecipients(activity);
      
      if (recipients.length === 0) {
        logger.debug('Shared inbox: No local recipients found');
        return res.status(202).json({ status: 'no local recipients' });
      }

      // Dispatch to individual inboxes
      const results = await this.dispatchToRecipients(activity, recipients, actorUri);

      this.stats.processed++;
      logger.info(`Shared inbox: Processed ${activity.type} from ${actorUri} to ${recipients.length} recipients`);

      res.status(202).json({
        status: 'accepted',
        recipients: results.length,
      });

    } catch (err) {
      this.stats.errors++;
      logger.error('Shared inbox error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Extract local recipients from an activity
   * @param {Object} activity - The activity
   * @returns {Array<string>} - Array of local usernames
   */
  extractRecipients(activity) {
    const recipients = new Set();
    const baseUrl = config.activityPodsUrl;

    // Collect all recipient fields
    const recipientFields = ['to', 'cc', 'bto', 'bcc', 'audience'];
    
    for (const field of recipientFields) {
      const values = activity[field];
      if (!values) continue;

      const valueArray = Array.isArray(values) ? values : [values];
      
      for (const value of valueArray) {
        const uri = typeof value === 'string' ? value : value?.id || value?.['@id'];
        
        if (uri && uri.startsWith(baseUrl)) {
          // Extract username from URI
          const match = uri.match(/\/users\/([^\/]+)/);
          if (match) {
            recipients.add(match[1]);
          }
        }
      }
    }

    return Array.from(recipients);
  }

  /**
   * Dispatch activity to individual recipient inboxes
   * @param {Object} activity - The activity
   * @param {Array<string>} recipients - Array of usernames
   * @param {string} actorUri - The sender's actor URI
   * @returns {Promise<Array>}
   */
  async dispatchToRecipients(activity, recipients, actorUri) {
    const results = [];

    for (const username of recipients) {
      try {
        await inboxHandler.forwardToActivityPods(username, activity, actorUri);
        results.push({ username, success: true });
      } catch (err) {
        logger.error(`Failed to dispatch to ${username}:`, err);
        results.push({ username, success: false, error: err.message });
      }
    }

    // Also publish to inbound stream for monitoring
    await redisService.publish(config.streams.inbound, {
      type: 'shared-inbox',
      actorUri,
      activity,
      recipients,
      receivedAt: new Date().toISOString(),
    });

    return results;
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      received: 0,
      processed: 0,
      errors: 0,
    };
  }
}

export const sharedInboxHandler = new SharedInboxHandler();
export default sharedInboxHandler;
