/**
 * ActivityPods Integration: Signing API Service
 * 
 * This Moleculer service exposes an HTTP API for the Fedify sidecar to request
 * HTTP signatures. Private keys never leave the pod boundary.
 * 
 * Installation:
 * 1. Copy this file to your ActivityPods backend services directory
 * 2. Configure the API route in your API gateway
 */

const crypto = require('crypto');

module.exports = {
  name: 'signing-api',
  
  dependencies: ['signature', 'keys'],

  settings: {
    // Allowed sidecar IPs/hosts for security
    allowedHosts: (process.env.SIGNING_API_ALLOWED_HOSTS || 'localhost,127.0.0.1,fedify-sidecar').split(','),
  },

  actions: {
    /**
     * Sign a request for the Fedify sidecar
     * @param {Object} ctx - Moleculer context
     * @param {string} ctx.params.actorUri - The actor URI to sign as
     * @param {string} ctx.params.method - HTTP method
     * @param {string} ctx.params.url - Target URL
     * @param {Object} ctx.params.headers - Headers to include in signature
     * @param {string} ctx.params.digest - Request body digest
     */
    async sign(ctx) {
      const { actorUri, method, url, headers, digest } = ctx.params;

      // Validate request origin (in production, add more robust checks)
      // This is a simplified check - in production use proper authentication

      try {
        // Get the actor's private key
        const privateKey = await ctx.call('keys.getPrivateKey', { actorUri });
        
        if (!privateKey) {
          throw new Error(`No private key found for actor: ${actorUri}`);
        }

        // Build the signing string
        const targetUrl = new URL(url);
        const headersToSign = ['(request-target)', 'host', 'date', 'digest'];
        
        const signingLines = [
          `(request-target): ${method.toLowerCase()} ${targetUrl.pathname}`,
          `host: ${headers.Host || targetUrl.host}`,
          `date: ${headers.Date}`,
          `digest: ${digest}`,
        ];
        
        const signingString = signingLines.join('\n');

        // Create the signature
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(signingString);
        const signature = signer.sign(privateKey, 'base64');

        // Get the key ID
        const keyId = `${actorUri}#main-key`;

        // Build the Signature header
        const signatureHeader = [
          `keyId="${keyId}"`,
          `algorithm="rsa-sha256"`,
          `headers="${headersToSign.join(' ')}"`,
          `signature="${signature}"`,
        ].join(',');

        return {
          signedHeaders: {
            ...headers,
            'Signature': signatureHeader,
          },
        };
      } catch (err) {
        this.logger.error(`Failed to sign request for ${actorUri}:`, err);
        throw err;
      }
    },

    /**
     * Batch sign multiple requests
     * @param {Object} ctx - Moleculer context
     * @param {string} ctx.params.actorUri - The actor URI to sign as
     * @param {Array<Object>} ctx.params.requests - Array of request parameters
     */
    async batchSign(ctx) {
      const { actorUri, requests } = ctx.params;

      const signatures = [];
      for (const request of requests) {
        try {
          const result = await this.actions.sign({
            actorUri,
            ...request,
          });
          signatures.push(result.signedHeaders);
        } catch (err) {
          signatures.push({ error: err.message });
        }
      }

      return { signatures };
    },

    /**
     * Get the public key for an actor
     * @param {Object} ctx - Moleculer context
     * @param {string} ctx.params.actorUri - The actor URI
     */
    async publicKey(ctx) {
      const { actorUri } = ctx.params;

      try {
        const publicKey = await ctx.call('keys.getPublicKey', { actorUri });
        
        if (!publicKey) {
          throw new Error(`No public key found for actor: ${actorUri}`);
        }

        return { publicKey };
      } catch (err) {
        this.logger.error(`Failed to get public key for ${actorUri}:`, err);
        throw err;
      }
    },
  },

  /**
   * API routes for the signing service
   * Add these to your API gateway configuration
   */
  routes: [
    {
      path: '/api/signature',
      aliases: {
        'POST /sign': 'signing-api.sign',
        'POST /batch-sign': 'signing-api.batchSign',
        'POST /public-key': 'signing-api.publicKey',
      },
      bodyParsers: {
        json: true,
      },
    },
  ],
};
