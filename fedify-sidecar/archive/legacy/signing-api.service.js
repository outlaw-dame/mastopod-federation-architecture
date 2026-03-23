/**
 * ActivityPods Integration: Signing API Service (v5)
 * 
 * This Moleculer service exposes an HTTP API for the Fedify sidecar to request
 * HTTP signatures. Private keys never leave the pod boundary.
 * 
 * Contract (per v5 architecture):
 * - POST /api/internal/signatures/batch
 * - Request: { requests: SignRequest[] }
 * - Response: { results: SignResult[] }
 * - Each request carries its own actorUri, targetUrl, headers, body
 * - Bearer token authentication required
 * 
 * Installation:
 * 1. Copy this file to your ActivityPods backend services directory
 * 2. Configure the API route in your API gateway
 * 3. Set SIGNING_API_TOKEN environment variable for authentication
 */

const crypto = require('crypto');

module.exports = {
  name: 'signing-api',
  
  dependencies: ['signature', 'keys'],

  settings: {
    // Internal API authentication token
    internalApiToken: process.env.SIGNING_API_TOKEN || 'change-me-in-production',
    
    // Allowed sidecar IPs/hosts for additional security (optional)
    allowedHosts: (process.env.SIGNING_API_ALLOWED_HOSTS || 'localhost,127.0.0.1,fedify-sidecar').split(','),
  },

  /**
   * Middleware to check internal API authentication
   */
  middlewares: [
    {
      name: 'auth',
      use(req, res, next) {
        // Only apply to internal API routes
        if (!req.url.startsWith('/api/internal/')) {
          return next();
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'Missing or invalid authorization' });
        }

        const token = authHeader.substring(7);
        if (token !== this.settings.internalApiToken) {
          return res.status(403).json({ error: 'Invalid authentication token' });
        }

        next();
      },
    },
  ],

  actions: {
    /**
     * Batch sign multiple requests (v5 contract)
     * 
     * @param {Object} ctx - Moleculer context
     * @param {Array<Object>} ctx.params.requests - Array of SignRequest objects
     *   Each request has: requestId, actorUri, method, targetUrl, headers, body?, options?
     */
    async 'batch'(ctx) {
      const { requests } = ctx.params;

      if (!Array.isArray(requests)) {
        throw new Error('requests must be an array');
      }

      const results = [];

      for (const request of requests) {
        try {
          const result = await this.signRequest(ctx, request);
          results.push(result);
        } catch (err) {
          this.logger.error(`Failed to sign request ${request.requestId}:`, err);
          results.push({
            requestId: request.requestId,
            ok: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err.message,
            },
          });
        }
      }

      return { results };
    },

    /**
     * Sign a single request (internal helper)
     */
    async 'sign'(ctx) {
      const request = ctx.params;
      return this.signRequest(ctx, request);
    },
  },

  /**
   * Helper method to sign a single request
   */
  async signRequest(ctx, request) {
    const { requestId, actorUri, method, targetUrl, headers, body, options } = request;

    try {
      // Validate required fields
      if (!actorUri || !method || !targetUrl || !headers) {
        return {
          requestId,
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required fields: actorUri, method, targetUrl, headers',
          },
        };
      }

      // Get the actor's private key
      let privateKey;
      try {
        privateKey = await ctx.call('keys.getPrivateKey', { actorUri });
      } catch (err) {
        this.logger.warn(`Failed to get private key for ${actorUri}:`, err);
        return {
          requestId,
          ok: false,
          error: {
            code: 'ACTOR_NOT_FOUND',
            message: `No private key found for actor: ${actorUri}`,
          },
        };
      }

      if (!privateKey) {
        return {
          requestId,
          ok: false,
          error: {
            code: 'KEY_NOT_FOUND',
            message: `No private key material available for actor: ${actorUri}`,
          },
        };
      }

      // Parse target URL
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch (err) {
        return {
          requestId,
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: `Invalid targetUrl: ${err.message}`,
          },
        };
      }

      // Determine headers to sign
      const headersToSign = options?.signatureHeaders || ['(request-target)', 'host', 'date', 'digest'];

      // Build the signing string
      const signingLines = [];
      for (const header of headersToSign) {
        if (header === '(request-target)') {
          signingLines.push(`(request-target): ${method.toLowerCase()} ${parsedUrl.pathname}${parsedUrl.search || ''}`);
        } else {
          const headerValue = headers[header] || headers[header.toLowerCase()];
          if (!headerValue) {
            return {
              requestId,
              ok: false,
              error: {
                code: 'INVALID_REQUEST',
                message: `Missing required header for signing: ${header}`,
              },
            };
          }
          signingLines.push(`${header.toLowerCase()}: ${headerValue}`);
        }
      }

      const signingString = signingLines.join('\n');

      // Create the signature
      let signature;
      try {
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(signingString);
        signature = signer.sign(privateKey, 'base64');
      } catch (err) {
        this.logger.error(`Failed to create signature for ${actorUri}:`, err);
        return {
          requestId,
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: `Signature creation failed: ${err.message}`,
          },
        };
      }

      // Get the key ID (use keyId from options if provided, otherwise derive)
      const keyId = options?.keyId || `${actorUri}#main-key`;

      // Build the Signature header value
      const signatureHeaderValue = [
        `keyId="${keyId}"`,
        `algorithm="rsa-sha256"`,
        `headers="${headersToSign.join(' ')}"`,
        `signature="${signature}"`,
      ].join(',');

      // Build response with signed headers
      const signedHeaders = {
        date: headers.date || headers.Date,
        signature: signatureHeaderValue,
      };

      // Include digest if present in request
      if (headers.digest || headers.Digest) {
        signedHeaders.digest = headers.digest || headers.Digest;
      }

      return {
        requestId,
        ok: true,
        signedHeaders,
        meta: {
          keyId,
          algorithm: 'rsa-sha256',
          signedHeadersList: headersToSign,
        },
      };
    },
  },

  /**
   * API routes for the signing service
   * Add these to your API gateway configuration
   */
  routes: [
    {
      path: '/api/internal/signatures',
      aliases: {
        'POST /batch': 'signing-api.batch',
      },
      bodyParsers: {
        json: true,
      },
      // Require internal authentication
      authentication: true,
      authorization: true,
    },
  ],
};
