/**
 * ActivityPods Integration: Internal Inbox Receiver Service (v5)
 * 
 * This Moleculer service receives pre-verified activities from the Fedify sidecar
 * via an internal API endpoint. The sidecar has already verified the HTTP signature,
 * so we trust the verification result and skip signature verification in ActivityPods.
 * 
 * Contract (per v5 architecture):
 * - POST /api/internal/inbox/receive
 * - Request: { targetInbox, activity, verifiedActorUri, receivedAt, remoteIp }
 * - Response: { success: true/false, error?: string }
 * - Bearer token authentication required
 * - Fail-closed: reject if verification evidence is missing or invalid
 * 
 * Installation:
 * 1. Copy this file to your ActivityPods backend services directory
 * 2. Configure the API route in your API gateway
 * 3. Set INTERNAL_API_TOKEN environment variable for authentication
 */

module.exports = {
  name: 'internal-inbox-receiver',
  
  dependencies: ['activitypub.inbox'],

  settings: {
    // Internal API authentication token
    internalApiToken: process.env.INTERNAL_API_TOKEN || 'change-me-in-production',
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
     * Receive a pre-verified activity from the Fedify sidecar
     * 
     * @param {Object} ctx - Moleculer context
     * @param {string} ctx.params.targetInbox - The inbox URL that received the activity
     * @param {Object} ctx.params.activity - The activity to process
     * @param {string} ctx.params.verifiedActorUri - The actor URI (already verified by sidecar)
     * @param {number} ctx.params.receivedAt - Timestamp when activity was received
     * @param {string} ctx.params.remoteIp - IP address of the remote actor
     */
    async receive(ctx) {
      const { targetInbox, activity, verifiedActorUri, receivedAt, remoteIp } = ctx.params;

      // Validate required fields - FAIL-CLOSED
      if (!targetInbox || !activity || !verifiedActorUri || receivedAt === undefined) {
        this.logger.error('Received incomplete activity from sidecar', {
          targetInbox: !!targetInbox,
          activity: !!activity,
          verifiedActorUri: !!verifiedActorUri,
          receivedAt: receivedAt !== undefined,
        });
        throw new Error('Missing required fields: targetInbox, activity, verifiedActorUri, receivedAt');
      }

      // Validate activity structure
      if (!activity.type || !activity.actor) {
        this.logger.error('Received activity with missing required fields', {
          activityId: activity.id,
          type: activity.type,
          actor: activity.actor,
        });
        throw new Error('Activity missing required fields: type, actor');
      }

      try {
        // Extract inbox path from targetInbox URL
        // Format: http://localhost:3000/users/{username}/inbox
        let inboxPath;
        try {
          const url = new URL(targetInbox);
          inboxPath = url.pathname;
        } catch (err) {
          this.logger.error('Invalid targetInbox URL', { targetInbox, error: err.message });
          throw new Error(`Invalid targetInbox URL: ${err.message}`);
        }

        // Parse the inbox path to extract username
        // Supported formats: /users/{username}/inbox, /{username}/inbox
        const usernameMatch = inboxPath.match(/\/(?:users\/)?([^/]+)\/inbox$/);
        if (!usernameMatch) {
          this.logger.error('Could not extract username from inbox path', { inboxPath });
          throw new Error(`Invalid inbox path format: ${inboxPath}`);
        }

        const username = usernameMatch[1];
        const baseUrl = this.broker.options.baseUrl || process.env.SEMAPPS_HOME_URL || 'http://localhost:3000';
        const recipientUri = `${baseUrl}/users/${username}`;

        this.logger.debug('Processing verified activity', {
          activityId: activity.id,
          activityType: activity.type,
          actor: verifiedActorUri,
          recipient: recipientUri,
          receivedAt: new Date(receivedAt).toISOString(),
          remoteIp,
        });

        // Process the activity through the normal inbox pipeline
        // CRITICAL: skipSignatureVerification=true because sidecar already verified
        // The sidecar is the trust boundary - we trust its verification result
        const result = await ctx.call('activitypub.inbox.post', {
          collectionUri: targetInbox,
          activity,
          actor: verifiedActorUri,
          skipSignatureVerification: true,
          meta: {
            verifiedBySidecar: true,
            receivedAt,
            remoteIp,
          },
        });

        this.logger.info('Successfully processed verified activity', {
          activityId: activity.id,
          activityType: activity.type,
          actor: verifiedActorUri,
          recipient: recipientUri,
        });

        return { success: true, result };

      } catch (err) {
        this.logger.error('Failed to process activity from sidecar', {
          activityId: activity.id,
          actor: verifiedActorUri,
          error: err.message,
          stack: err.stack,
        });

        // Determine if error is permanent or transient
        const isPermanent = 
          err.message.includes('not found') ||
          err.message.includes('invalid') ||
          err.message.includes('unauthorized');

        throw {
          statusCode: isPermanent ? 400 : 500,
          message: err.message,
          permanent: isPermanent,
        };
      }
    },

    /**
     * Health check for the inbox receiver
     */
    health() {
      return { status: 'healthy', timestamp: new Date().toISOString() };
    },
  },

  /**
   * API routes for the internal inbox receiver
   * Add these to your API gateway configuration
   */
  routes: [
    {
      path: '/api/internal/inbox',
      aliases: {
        'POST /receive': 'internal-inbox-receiver.receive',
        'GET /health': 'internal-inbox-receiver.health',
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
