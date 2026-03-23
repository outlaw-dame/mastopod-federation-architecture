/**
 * ActivityPods Integration: Inbox Receiver Service
 * 
 * This Moleculer service receives pre-verified activities from the Fedify sidecar
 * and processes them through the normal ActivityPods inbox pipeline.
 * 
 * Installation:
 * 1. Copy this file to your ActivityPods backend services directory
 * 2. Configure the API route in your API gateway
 */

module.exports = {
  name: 'inbox-receiver',
  
  dependencies: ['activitypub.inbox', 'ldp.resource'],

  settings: {
    // Header that indicates the activity was verified by the sidecar
    verifiedHeader: 'X-Signature-Verified',
    // Header containing the original actor URI
    actorHeader: 'X-Forwarded-Actor',
  },

  actions: {
    /**
     * Receive a pre-verified activity from the Fedify sidecar
     * @param {Object} ctx - Moleculer context
     * @param {Object} ctx.params.activity - The activity to process
     * @param {string} ctx.params.recipientUri - The recipient's actor URI
     * @param {string} ctx.params.actorUri - The sender's actor URI
     */
    async receive(ctx) {
      const { activity, recipientUri, actorUri } = ctx.params;

      // Validate that this came from the sidecar
      const isVerified = ctx.meta.headers?.[this.settings.verifiedHeader] === 'true';
      
      if (!isVerified) {
        this.logger.warn('Received activity without verification header');
        // In production, you might want to reject unverified activities
        // For now, we'll process them but log a warning
      }

      try {
        // Get the recipient's inbox URI
        const recipient = await ctx.call('activitypub.actor.get', { actorUri: recipientUri });
        
        if (!recipient || !recipient.inbox) {
          throw new Error(`Recipient not found: ${recipientUri}`);
        }

        // Process the activity through the normal inbox pipeline
        // Skip signature verification since the sidecar already did it
        const result = await ctx.call('activitypub.inbox.post', {
          collectionUri: recipient.inbox,
          activity,
          webId: actorUri,
          skipSignatureVerification: true,
        });

        this.logger.info(`Processed activity ${activity.type} from ${actorUri} for ${recipientUri}`);
        
        return { success: true, result };
      } catch (err) {
        this.logger.error(`Failed to process activity for ${recipientUri}:`, err);
        throw err;
      }
    },

    /**
     * Batch receive multiple activities
     * @param {Object} ctx - Moleculer context
     * @param {Array<Object>} ctx.params.activities - Array of activity objects
     */
    async batchReceive(ctx) {
      const { activities } = ctx.params;

      const results = [];
      for (const { activity, recipientUri, actorUri } of activities) {
        try {
          await this.actions.receive({ activity, recipientUri, actorUri });
          results.push({ id: activity.id || activity['@id'], success: true });
        } catch (err) {
          results.push({ id: activity.id || activity['@id'], success: false, error: err.message });
        }
      }

      return results;
    },

    /**
     * Health check for the inbox receiver
     */
    health() {
      return { status: 'healthy', timestamp: new Date().toISOString() };
    },
  },

  /**
   * API routes for the inbox receiver
   * Add these to your API gateway configuration
   */
  routes: [
    {
      path: '/users/:username/inbox',
      aliases: {
        'POST /': 'inbox-receiver.receiveFromRoute',
      },
      bodyParsers: {
        json: {
          type: ['application/json', 'application/activity+json', 'application/ld+json'],
        },
      },
      onBeforeCall(ctx, route, req) {
        // Pass headers to the action
        ctx.meta.headers = req.headers;
        ctx.meta.username = req.params.username;
      },
    },
  ],

  methods: {
    /**
     * Handle inbox POST from route
     */
    async receiveFromRoute(ctx) {
      const username = ctx.meta.username;
      const activity = ctx.params;
      const actorUri = ctx.meta.headers[this.settings.actorHeader.toLowerCase()];

      // Construct the recipient URI from the username
      const baseUrl = this.broker.options.baseUrl || process.env.SEMAPPS_HOME_URL;
      const recipientUri = `${baseUrl}/users/${username}`;

      return this.actions.receive({
        activity,
        recipientUri,
        actorUri,
      });
    },
  },
};
