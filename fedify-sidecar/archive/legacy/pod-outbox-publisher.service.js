/**
 * ActivityPods Integration: Pod Outbox Publisher Service
 * 
 * This Moleculer service should be added to the ActivityPods backend to publish
 * activities to Stream1 for the Fedify sidecar to consume.
 * 
 * Installation:
 * 1. Copy this file to your ActivityPods backend services directory
 * 2. Add Redis dependency to your package.json
 * 3. Configure REDIS_URL and STREAM_OUTBOUND in your environment
 */

const Redis = require('ioredis');

module.exports = {
  name: 'pod-outbox-publisher',
  
  settings: {
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    streamName: process.env.STREAM_OUTBOUND || 'ap:stream1:outbound',
  },

  created() {
    this.redis = new Redis(this.settings.redisUrl);
    this.redis.on('error', (err) => {
      this.logger.error('Redis connection error:', err);
    });
  },

  async stopped() {
    await this.redis.quit();
  },

  actions: {
    /**
     * Publish an activity to Stream1 for federation delivery
     * @param {Object} ctx - Moleculer context
     * @param {string} ctx.params.actorUri - The actor URI sending the activity
     * @param {Object} ctx.params.activity - The activity to publish
     * @param {Array<string>} ctx.params.recipients - Array of recipient inbox URLs
     */
    async publish(ctx) {
      const { actorUri, activity, recipients } = ctx.params;

      if (!actorUri || !activity || !recipients || recipients.length === 0) {
        throw new Error('Missing required parameters: actorUri, activity, recipients');
      }

      const message = {
        actorUri,
        activityData: activity,
        recipients,
        publishedAt: new Date().toISOString(),
      };

      try {
        await this.redis.publish(
          this.settings.streamName,
          JSON.stringify(message)
        );

        this.logger.info(`Published activity ${activity.id || activity['@id']} to Stream1`);
        return { success: true };
      } catch (err) {
        this.logger.error('Failed to publish to Stream1:', err);
        throw err;
      }
    },

    /**
     * Batch publish multiple activities
     * @param {Object} ctx - Moleculer context
     * @param {Array<Object>} ctx.params.activities - Array of activity objects
     */
    async batchPublish(ctx) {
      const { activities } = ctx.params;

      const results = [];
      for (const { actorUri, activity, recipients } of activities) {
        try {
          await this.actions.publish({ actorUri, activity, recipients });
          results.push({ id: activity.id || activity['@id'], success: true });
        } catch (err) {
          results.push({ id: activity.id || activity['@id'], success: false, error: err.message });
        }
      }

      return results;
    },
  },

  events: {
    /**
     * Listen for outbox activity events and automatically publish
     * This integrates with the existing ActivityPods event system
     */
    async 'activitypub.outbox.post'(ctx) {
      const { activity, recipients, webId } = ctx.params;

      // Only publish if there are remote recipients
      const remoteRecipients = recipients.filter(r => !r.startsWith(this.broker.options.baseUrl));
      
      if (remoteRecipients.length > 0) {
        await this.actions.publish({
          actorUri: webId,
          activity,
          recipients: remoteRecipients,
        });
      }
    },
  },
};
