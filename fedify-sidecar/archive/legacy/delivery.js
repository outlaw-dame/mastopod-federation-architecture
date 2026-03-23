import config from '../config/index.js';
import logger from '../utils/logger.js';
import signingService from './signing.js';
import redpandaService from './redpanda.js';

/**
 * Delivery service for outbound federation
 * Consumes from Stream1 and delivers to remote inboxes
 */
class DeliveryService {
  constructor() {
    // Per-domain rate limiting
    this.domainQueues = new Map();
    // Retry tracking
    this.retryBackoff = new Map();
    // Statistics
    this.stats = {
      delivered: 0,
      failed: 0,
      retried: 0,
    };
  }

  /**
   * Initialize the delivery service
   */
  async initialize() {
    // Start consuming from Stream1
    await redpandaService.startDeliveryConsumer(
      this.handleDeliveryMessage.bind(this)
    );

    logger.info('Delivery service initialized');
  }

  /**
   * Handle a message from Stream1
   * @param {Object} message - Kafka message
   */
  async handleDeliveryMessage(message) {
    const { value } = message;
    const { actorUri, activity } = value;

    try {
      // Determine remote recipients
      const recipients = this.extractRemoteRecipients(activity);
      
      if (recipients.length === 0) {
        logger.debug(`No remote recipients for activity from ${actorUri}`);
        return;
      }

      // Deliver to each recipient
      for (const inboxUrl of recipients) {
        await this.deliverToInbox(actorUri, activity, inboxUrl);
      }
    } catch (err) {
      logger.error(`Error processing delivery message:`, err);
    }
  }

  /**
   * Extract remote recipient inbox URLs from an activity
   * @param {Object} activity - The activity
   * @returns {Array<string>} - Array of inbox URLs
   */
  extractRemoteRecipients(activity) {
    const recipients = new Set();
    const localDomain = new URL(config.activityPodsUrl).hostname;

    // Collect all recipient fields
    const recipientFields = ['to', 'cc', 'bto', 'bcc'];
    
    for (const field of recipientFields) {
      const values = activity[field];
      if (!values) continue;

      const valueArray = Array.isArray(values) ? values : [values];
      
      for (const value of valueArray) {
        // Skip public addressing
        if (value === 'https://www.w3.org/ns/activitystreams#Public' ||
            value === 'as:Public') {
          continue;
        }

        const uri = typeof value === 'string' ? value : value?.id || value?.['@id'];
        
        if (uri) {
          try {
            const domain = new URL(uri).hostname;
            // Only include remote recipients
            if (domain !== localDomain) {
              recipients.add(uri);
            }
          } catch (e) {
            // Invalid URL, skip
          }
        }
      }
    }

    return Array.from(recipients);
  }

  /**
   * Deliver an activity to a remote inbox
   * @param {string} actorUri - The sender's actor URI
   * @param {Object} activity - The activity to deliver
   * @param {string} recipientUri - The recipient's actor URI
   * @param {number} attempt - Current attempt number
   */
  async deliverToInbox(actorUri, activity, recipientUri, attempt = 1) {
    try {
      // Resolve the recipient's inbox URL
      const inboxUrl = await this.resolveInbox(recipientUri);
      
      if (!inboxUrl) {
        logger.warn(`Could not resolve inbox for ${recipientUri}`);
        return;
      }

      const domain = new URL(inboxUrl).hostname;

      // Check rate limit for domain
      await this.waitForDomainSlot(domain);

      // Prepare the request
      const body = JSON.stringify(activity);
      const digest = await this.createDigest(body);
      const date = new Date().toUTCString();

      const headers = {
        'Content-Type': 'application/activity+json',
        'Date': date,
        'Digest': digest,
        'Host': new URL(inboxUrl).host,
      };

      // Sign the request
      const signedHeaders = await signingService.sign(actorUri, 'POST', inboxUrl, headers, digest);

      // Send the request
      const response = await fetch(inboxUrl, {
        method: 'POST',
        headers: signedHeaders,
        body,
        signal: AbortSignal.timeout(config.federation.requestTimeout),
      });

      if (response.ok || response.status === 202) {
        this.stats.delivered++;
        this.retryBackoff.delete(`${actorUri}:${recipientUri}`);
        logger.info(`Delivered to ${inboxUrl} (${response.status})`);
        return;
      }

      // Handle specific error codes
      if (response.status === 410) {
        // Gone - actor deleted, don't retry
        logger.info(`Recipient gone: ${recipientUri}`);
        return;
      }

      if (response.status === 404) {
        // Not found - don't retry
        logger.info(`Inbox not found: ${inboxUrl}`);
        return;
      }

      // Retry on server errors
      if (response.status >= 500 && attempt < config.federation.maxRetries) {
        await this.scheduleRetry(actorUri, activity, recipientUri, attempt);
      } else {
        this.stats.failed++;
        logger.error(`Delivery failed to ${inboxUrl}: ${response.status}`);
      }

    } catch (err) {
      if (attempt < config.federation.maxRetries) {
        await this.scheduleRetry(actorUri, activity, recipientUri, attempt);
      } else {
        this.stats.failed++;
        logger.error(`Delivery failed to ${recipientUri}:`, err.message);
      }
    }
  }

  /**
   * Resolve the inbox URL for an actor
   * @param {string} actorUri - The actor URI
   * @returns {Promise<string|null>}
   */
  async resolveInbox(actorUri) {
    // Check if it's already an inbox URL
    if (actorUri.endsWith('/inbox')) {
      return actorUri;
    }

    try {
      const response = await fetch(actorUri, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return null;
      }

      const actor = await response.json();
      return actor.inbox || null;
    } catch (err) {
      logger.error(`Failed to resolve inbox for ${actorUri}:`, err.message);
      return null;
    }
  }

  /**
   * Create a SHA-256 digest of the body
   * @param {string} body - Request body
   * @returns {Promise<string>}
   */
  async createDigest(body) {
    const encoder = new TextEncoder();
    const data = encoder.encode(body);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray));
    return `SHA-256=${hashBase64}`;
  }

  /**
   * Wait for a slot in the domain's rate limit
   * @param {string} domain - The domain
   */
  async waitForDomainSlot(domain) {
    if (!this.domainQueues.has(domain)) {
      this.domainQueues.set(domain, {
        active: 0,
        queue: [],
      });
    }

    const domainState = this.domainQueues.get(domain);

    if (domainState.active >= config.federation.maxConcurrentPerDomain) {
      // Wait for a slot
      await new Promise(resolve => {
        domainState.queue.push(resolve);
      });
    }

    domainState.active++;

    // Release slot after request completes
    setTimeout(() => {
      domainState.active--;
      if (domainState.queue.length > 0) {
        const next = domainState.queue.shift();
        next();
      }
    }, 100);
  }

  /**
   * Schedule a retry with exponential backoff
   * @param {string} actorUri - The sender's actor URI
   * @param {Object} activity - The activity
   * @param {string} recipientUri - The recipient URI
   * @param {number} attempt - Current attempt number
   */
  async scheduleRetry(actorUri, activity, recipientUri, attempt) {
    const key = `${actorUri}:${recipientUri}`;
    const delay = config.federation.retryDelay * Math.pow(2, attempt - 1);

    this.stats.retried++;
    logger.info(`Scheduling retry ${attempt + 1} for ${recipientUri} in ${delay}ms`);

    setTimeout(() => {
      this.deliverToInbox(actorUri, activity, recipientUri, attempt + 1);
    }, delay);
  }

  /**
   * Get delivery statistics
   * @returns {Object}
   */
  getStats() {
    return { ...this.stats };
  }
}

export const deliveryService = new DeliveryService();
export default deliveryService;
