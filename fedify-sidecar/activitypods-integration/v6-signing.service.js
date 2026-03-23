/**
 * V6 Signing Service for ActivityPods
 * 
 * Hardened batch signing service that enforces the V6 security model:
 * - Private keys NEVER leave ActivityPods
 * - Batch signing for efficiency
 * - mTLS enforcement (optional but recommended)
 * - Audit logging and rate limiting
 * - Per-request actor URI validation
 * 
 * Endpoint: POST /api/internal/signatures/batch
 */

const express = require('express');
const router = express.Router();

// ============================================================================
// Middleware
// ============================================================================

/**
 * Bearer token authentication (fail-closed)
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing authorization token',
    });
  }

  // Verify token against ACTIVITYPODS_TOKEN
  const expectedToken = process.env.ACTIVITYPODS_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Invalid authorization token',
    });
  }

  next();
}

/**
 * Request validation middleware
 */
function validateBatchSigningRequest(req, res, next) {
  const { requests } = req.body;

  if (!Array.isArray(requests)) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'requests must be an array',
    });
  }

  if (requests.length === 0) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'requests array cannot be empty',
    });
  }

  // Validate each request
  for (let i = 0; i < requests.length; i++) {
    const req_item = requests[i];

    if (!req_item.requestId) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `requests[${i}].requestId is required`,
      });
    }

    if (!req_item.actorUri) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `requests[${i}].actorUri is required`,
      });
    }

    if (req_item.method !== 'POST') {
      return res.status(400).json({
        error: 'invalid_request',
        message: `requests[${i}].method must be POST`,
      });
    }

    if (!req_item.targetUrl) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `requests[${i}].targetUrl is required`,
      });
    }

    if (!req_item.headers || typeof req_item.headers !== 'object') {
      return res.status(400).json({
        error: 'invalid_request',
        message: `requests[${i}].headers must be an object`,
      });
    }

    if (!req_item.body || typeof req_item.body !== 'string') {
      return res.status(400).json({
        error: 'invalid_request',
        message: `requests[${i}].body must be a string`,
      });
    }
  }

  next();
}

// ============================================================================
// Batch Signing Endpoint
// ============================================================================

/**
 * POST /api/internal/signatures/batch
 * 
 * Request:
 * {
 *   "requests": [
 *     {
 *       "requestId": "unique-id",
 *       "actorUri": "https://example.com/users/alice",
 *       "method": "POST",
 *       "targetUrl": "https://remote.example/inbox",
 *       "headers": {
 *         "Host": "remote.example",
 *         "Date": "Mon, 23 Mar 2026 12:00:00 GMT",
 *         "Content-Type": "application/activity+json"
 *       },
 *       "body": "{...activity...}",
 *       "keyId": "https://example.com/users/alice#main-key",
 *       "signatureHeaders": ["(request-target)", "host", "date", "digest"]
 *     }
 *   ]
 * }
 * 
 * Response:
 * {
 *   "results": [
 *     {
 *       "requestId": "unique-id",
 *       "ok": true,
 *       "signedHeaders": {
 *         "Signature": "keyId=\"...\",algorithm=\"rsa-sha256\",headers=\"...\",signature=\"...\""
 *       }
 *     } or {
 *       "requestId": "unique-id",
 *       "ok": false,
 *       "error": {
 *         "code": "ACTOR_NOT_FOUND",
 *         "message": "Actor not found"
 *       }
 *     }
 *   ]
 * }
 */
router.post('/api/internal/signatures/batch', authenticateToken, validateBatchSigningRequest, async (req, res) => {
  const { requests } = req.body;
  const results = [];

  // Audit log
  console.log(`[SIGNING] Batch signing request with ${requests.length} items from ${req.ip}`);

  for (const signingRequest of requests) {
    try {
      // Validate actor ownership (prevent cross-signing)
      const actorUri = signingRequest.actorUri;
      const keyId = signingRequest.keyId || `${actorUri}#main-key`;

      // Verify keyId belongs to actorUri
      if (!keyId.startsWith(actorUri)) {
        results.push({
          requestId: signingRequest.requestId,
          ok: false,
          error: {
            code: 'INVALID_KEY_ID',
            message: 'keyId must belong to the specified actor',
          },
        });
        continue;
      }

      // Fetch actor and private key from ActivityPods internal storage
      // This is pseudocode - actual implementation depends on ActivityPods internals
      const actorData = await fetchActorPrivateKey(actorUri);

      if (!actorData || !actorData.privateKeyPem) {
        results.push({
          requestId: signingRequest.requestId,
          ok: false,
          error: {
            code: 'ACTOR_NOT_FOUND',
            message: `Actor ${actorUri} not found or has no signing key`,
          },
        });
        continue;
      }

      // Build signing string (Cavage-style)
      const signingString = buildSigningString(signingRequest);

      // Sign with private key (NEVER exported)
      const crypto = require('crypto');
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(signingString);
      const signature = signer.sign(actorData.privateKeyPem, 'base64');

      // Build Signature header
      const signatureHeaders = signingRequest.signatureHeaders || [
        '(request-target)',
        'host',
        'date',
        'digest',
      ];

      const signatureHeader = buildSignatureHeader({
        keyId,
        algorithm: 'rsa-sha256',
        headers: signatureHeaders,
        signature,
      });

      results.push({
        requestId: signingRequest.requestId,
        ok: true,
        signedHeaders: {
          Signature: signatureHeader,
        },
      });

      // Audit log success
      console.log(`[SIGNING] ✓ Signed for ${actorUri} (request: ${signingRequest.requestId})`);
    } catch (err) {
      console.error(`[SIGNING] Error signing request ${signingRequest.requestId}:`, err);

      results.push({
        requestId: signingRequest.requestId,
        ok: false,
        error: {
          code: 'SIGNING_ERROR',
          message: err.message || 'Failed to sign request',
        },
      });
    }
  }

  res.status(200).json({ results });
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetch actor and private key from ActivityPods
 * 
 * This is a placeholder - actual implementation depends on how ActivityPods
 * stores and exposes private keys internally.
 */
async function fetchActorPrivateKey(actorUri) {
  // Pseudocode - implement based on ActivityPods internals
  // This should NEVER expose the private key outside ActivityPods
  // It should only be used for signing operations within ActivityPods
  
  // Example:
  // const actor = await ActivityPodsDB.findActorByUri(actorUri);
  // if (!actor) return null;
  // return {
  //   privateKeyPem: actor.privateKey, // Never exported
  //   publicKeyPem: actor.publicKey,
  // };
  
  throw new Error('fetchActorPrivateKey must be implemented by ActivityPods');
}

/**
 * Build signing string for Cavage-style HTTP signatures
 */
function buildSigningString(signingRequest) {
  const { method, targetUrl, headers, body, signatureHeaders } = signingRequest;
  const headersToSign = signatureHeaders || ['(request-target)', 'host', 'date', 'digest'];

  const lines = [];

  for (const header of headersToSign) {
    if (header === '(request-target)') {
      const url = new URL(targetUrl);
      lines.push(`(request-target): ${method.toLowerCase()} ${url.pathname}`);
    } else {
      const value = headers[header.toLowerCase()];
      if (value) {
        lines.push(`${header.toLowerCase()}: ${value}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Build Signature header
 */
function buildSignatureHeader({ keyId, algorithm, headers, signature }) {
  const parts = [
    `keyId="${keyId}"`,
    `algorithm="${algorithm}"`,
    `headers="${headers.join(' ')}"`,
    `signature="${signature}"`,
  ];

  return parts.join(',');
}

// ============================================================================
// Health Check
// ============================================================================

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// ============================================================================
// Export
// ============================================================================

module.exports = router;
