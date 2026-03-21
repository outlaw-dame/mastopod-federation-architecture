import config from '../config/index.js';
import logger from '../utils/logger.js';
import redpandaService from '../services/redpanda.js';

/**
 * Inbox handler for processing inbound activities
 * Verifies signatures and publishes to Stream2
 */
class InboxHandler {
  constructor() {
    // Cache for blocked domains
    this.blockedDomains = new Set();
    // Cache for actor public keys
    this.keyCache = new Map();
    // Deduplication cache
    this.dedupeCache = new Map();
  }

  /**
   * Initialize the inbox handler
   */
  async initialize() {
    // Load blocked domains from storage
    await this.loadBlockedDomains();
    
    // Clean up deduplication cache periodically
    setInterval(() => this.cleanupDedupeCache(), 3600000); // Every hour
    
    logger.info('Inbox handler initialized');
  }

  /**
   * Load blocked domains from storage
   */
  async loadBlockedDomains() {
    // In production, load from Redis or database
    // For now, use environment variable
    const blocked = process.env.BLOCKED_DOMAINS?.split(',') || [];
    this.blockedDomains = new Set(blocked.filter(d => d.trim()));
    logger.info(`Loaded ${this.blockedDomains.size} blocked domains`);
  }

  /**
   * Handle an incoming activity POST to an inbox
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async handleInboxPost(req, res) {
    const { username } = req.params;
    const activity = req.body;

    try {
      // Extract actor from the activity
      const actorUri = typeof activity.actor === 'string' 
        ? activity.actor 
        : activity.actor?.id || activity.actor?.['@id'];

      if (!actorUri) {
        logger.warn('Activity missing actor');
        return res.status(400).json({ error: 'Activity must have an actor' });
      }

      // Check if domain is blocked
      const actorDomain = new URL(actorUri).hostname;
      if (this.blockedDomains.has(actorDomain)) {
        logger.info(`Rejecting activity from blocked domain: ${actorDomain}`);
        return res.status(403).json({ error: 'Domain is blocked' });
      }

      // Verify HTTP signature
      const signatureValid = await this.verifySignature(req, actorUri);
      if (!signatureValid) {
        logger.warn(`Invalid signature for activity from ${actorUri}`);
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Deduplicate by activity ID
      const activityId = activity.id || activity['@id'];
      if (activityId && this.isDuplicate(activityId)) {
        logger.debug(`Skipping duplicate activity: ${activityId}`);
        return res.status(202).json({ status: 'already processed' });
      }

      // Check if activity is public
      const isPublic = this.isPublicActivity(activity);

      // Publish to Stream2 if public
      if (isPublic) {
        await redpandaService.publishToStream2(actorUri, activity, actorDomain);
        
        // Also publish to Firehose
        await redpandaService.publishToFirehose(actorUri, activity, 'remote');
      }

      // Forward to ActivityPods for inbox processing
      await this.forwardToActivityPods(username, activity, actorUri);

      logger.info(`Processed ${isPublic ? 'public' : 'private'} activity ${activity.type} from ${actorUri} for ${username}`);
      res.status(202).json({ status: 'accepted' });

    } catch (err) {
      logger.error('Error processing inbox activity:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Check if an activity is public
   * @param {Object} activity - The activity
   * @returns {boolean}
   */
  isPublicActivity(activity) {
    const publicAddresses = [
      'https://www.w3.org/ns/activitystreams#Public',
      'as:Public',
      'Public',
    ];

    const checkField = (field) => {
      if (!field) return false;
      const values = Array.isArray(field) ? field : [field];
      return values.some(v => {
        const uri = typeof v === 'string' ? v : v?.id || v?.['@id'];
        return publicAddresses.includes(uri);
      });
    };

    return checkField(activity.to) || checkField(activity.cc);
  }

  /**
   * Check if an activity ID is a duplicate
   * @param {string} activityId - The activity ID
   * @returns {boolean}
   */
  isDuplicate(activityId) {
    if (this.dedupeCache.has(activityId)) {
      return true;
    }
    this.dedupeCache.set(activityId, Date.now());
    return false;
  }

  /**
   * Clean up old entries from deduplication cache
   */
  cleanupDedupeCache() {
    const cutoff = Date.now() - 86400000; // 24 hours
    for (const [id, timestamp] of this.dedupeCache) {
      if (timestamp < cutoff) {
        this.dedupeCache.delete(id);
      }
    }
    logger.debug(`Cleaned up deduplication cache, ${this.dedupeCache.size} entries remaining`);
  }

  /**
   * Verify HTTP signature on the request
   * @param {Object} req - Express request object
   * @param {string} actorUri - The actor URI to verify against
   * @returns {Promise<boolean>}
   */
  async verifySignature(req, actorUri) {
    const signature = req.headers['signature'];
    if (!signature) {
      logger.debug('No signature header present');
      return false;
    }

    try {
      // Parse the signature header
      const signatureParts = this.parseSignatureHeader(signature);
      if (!signatureParts) {
        return false;
      }

      const { keyId, algorithm, headers, signatureValue } = signatureParts;

      // Fetch the public key
      const publicKey = await this.fetchPublicKey(keyId);
      if (!publicKey) {
        logger.warn(`Could not fetch public key: ${keyId}`);
        return false;
      }

      // Build the signing string
      const signingString = this.buildSigningString(req, headers.split(' '));

      // Verify the signature
      const isValid = await this.verifyRSASignature(
        signingString,
        signatureValue,
        publicKey
      );

      return isValid;
    } catch (err) {
      logger.error('Signature verification error:', err);
      return false;
    }
  }

  /**
   * Parse the Signature header
   * @param {string} header - The Signature header value
   * @returns {Object|null}
   */
  parseSignatureHeader(header) {
    const parts = {};
    const regex = /(\w+)="([^"]+)"/g;
    let match;

    while ((match = regex.exec(header)) !== null) {
      parts[match[1]] = match[2];
    }

    if (!parts.keyId || !parts.signature) {
      return null;
    }

    return {
      keyId: parts.keyId,
      algorithm: parts.algorithm || 'rsa-sha256',
      headers: parts.headers || 'date',
      signatureValue: parts.signature,
    };
  }

  /**
   * Fetch the public key for an actor
   * @param {string} keyId - The key ID (usually actor#main-key)
   * @returns {Promise<string|null>}
   */
  async fetchPublicKey(keyId) {
    // Check cache
    const cached = this.keyCache.get(keyId);
    if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour cache
      return cached.key;
    }

    try {
      // Extract actor URI from keyId
      const actorUri = keyId.split('#')[0];

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
      const publicKeyPem = actor.publicKey?.publicKeyPem;

      if (publicKeyPem) {
        this.keyCache.set(keyId, {
          key: publicKeyPem,
          timestamp: Date.now(),
        });
      }

      return publicKeyPem;
    } catch (err) {
      logger.error(`Failed to fetch public key ${keyId}:`, err);
      return null;
    }
  }

  /**
   * Build the signing string from request headers
   * @param {Object} req - Express request object
   * @param {Array<string>} headerNames - Headers to include
   * @returns {string}
   */
  buildSigningString(req, headerNames) {
    const lines = [];

    for (const name of headerNames) {
      if (name === '(request-target)') {
        lines.push(`(request-target): ${req.method.toLowerCase()} ${req.path}`);
      } else {
        const value = req.headers[name.toLowerCase()];
        if (value) {
          lines.push(`${name.toLowerCase()}: ${value}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Verify an RSA signature
   * @param {string} signingString - The string that was signed
   * @param {string} signatureBase64 - The base64-encoded signature
   * @param {string} publicKeyPem - The PEM-encoded public key
   * @returns {Promise<boolean>}
   */
  async verifyRSASignature(signingString, signatureBase64, publicKeyPem) {
    try {
      // Import the public key
      const keyData = this.pemToArrayBuffer(publicKeyPem);
      const publicKey = await crypto.subtle.importKey(
        'spki',
        keyData,
        {
          name: 'RSASSA-PKCS1-v1_5',
          hash: 'SHA-256',
        },
        false,
        ['verify']
      );

      // Decode the signature
      const signature = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));

      // Verify
      const encoder = new TextEncoder();
      const data = encoder.encode(signingString);

      return await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        signature,
        data
      );
    } catch (err) {
      logger.error('RSA verification error:', err);
      return false;
    }
  }

  /**
   * Convert PEM to ArrayBuffer
   * @param {string} pem - PEM-encoded key
   * @returns {ArrayBuffer}
   */
  pemToArrayBuffer(pem) {
    const base64 = pem
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\s/g, '');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Forward an activity to ActivityPods
   * @param {string} username - The recipient username
   * @param {Object} activity - The activity to forward
   * @param {string} actorUri - The sender's actor URI
   */
  async forwardToActivityPods(username, activity, actorUri) {
    const inboxUrl = `${config.activityPodsUrl}/users/${username}/inbox`;

    try {
      const response = await fetch(inboxUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json',
          'X-Forwarded-Actor': actorUri,
          'X-Signature-Verified': 'true',
        },
        body: JSON.stringify(activity),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`ActivityPods returned ${response.status}`);
      }

      logger.debug(`Forwarded activity to ActivityPods for ${username}`);
    } catch (err) {
      logger.error(`Failed to forward activity to ActivityPods:`, err);
      throw err;
    }
  }

  /**
   * Block a domain
   * @param {string} domain - Domain to block
   */
  async blockDomain(domain) {
    this.blockedDomains.add(domain);
    logger.info(`Blocked domain: ${domain}`);
  }

  /**
   * Unblock a domain
   * @param {string} domain - Domain to unblock
   */
  async unblockDomain(domain) {
    this.blockedDomains.delete(domain);
    logger.info(`Unblocked domain: ${domain}`);
  }
}

export const inboxHandler = new InboxHandler();
export default inboxHandler;
