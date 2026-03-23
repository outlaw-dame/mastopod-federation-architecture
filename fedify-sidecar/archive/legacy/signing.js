import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Signing service that interfaces with ActivityPods KeysService
 * Private keys never leave the pod boundary - we request signatures from the pod
 */
class SigningService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache for public keys
  }

  /**
   * Request a signature from the ActivityPods signing API
   * @param {string} actorUri - The actor URI to sign as
   * @param {Object} signatureParams - Parameters for the signature
   * @returns {Promise<Object>} - Signed headers
   */
  async requestSignature(actorUri, signatureParams) {
    const { method, url, headers, digest } = signatureParams;
    
    try {
      const response = await fetch(`${config.signingApi.url}/sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          actorUri,
          method,
          url,
          headers,
          digest,
        }),
        signal: AbortSignal.timeout(config.signingApi.timeout),
      });

      if (!response.ok) {
        throw new Error(`Signing API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      logger.debug(`Obtained signature for ${actorUri} to ${url}`);
      return result.signedHeaders;
    } catch (err) {
      logger.error(`Failed to get signature for ${actorUri}:`, err);
      throw err;
    }
  }

  /**
   * Batch request signatures for multiple deliveries
   * This is more efficient when delivering to many inboxes
   * @param {string} actorUri - The actor URI to sign as
   * @param {Array<Object>} requests - Array of request parameters
   * @returns {Promise<Array<Object>>} - Array of signed headers
   */
  async batchRequestSignatures(actorUri, requests) {
    try {
      const response = await fetch(`${config.signingApi.url}/batch-sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          actorUri,
          requests,
        }),
        signal: AbortSignal.timeout(config.signingApi.timeout * 2), // Double timeout for batch
      });

      if (!response.ok) {
        throw new Error(`Batch signing API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      logger.debug(`Obtained ${result.signatures.length} batch signatures for ${actorUri}`);
      return result.signatures;
    } catch (err) {
      logger.error(`Failed to get batch signatures for ${actorUri}:`, err);
      throw err;
    }
  }

  /**
   * Get the public key for an actor (for verification)
   * @param {string} actorUri - The actor URI
   * @returns {Promise<Object>} - Public key information
   */
  async getPublicKey(actorUri) {
    // Check cache first
    const cached = this.cache.get(actorUri);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.key;
    }

    try {
      const response = await fetch(`${config.signingApi.url}/public-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actorUri }),
        signal: AbortSignal.timeout(config.signingApi.timeout),
      });

      if (!response.ok) {
        throw new Error(`Public key API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      // Cache the result
      this.cache.set(actorUri, {
        key: result.publicKey,
        timestamp: Date.now(),
      });

      return result.publicKey;
    } catch (err) {
      logger.error(`Failed to get public key for ${actorUri}:`, err);
      throw err;
    }
  }

  /**
   * Clear the public key cache
   */
  clearCache() {
    this.cache.clear();
  }
}

export const signingService = new SigningService();
export default signingService;
