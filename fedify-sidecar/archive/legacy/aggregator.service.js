/**
 * ActivityPods Integration: Aggregator Service
 * 
 * This Moleculer service watches all pod outboxes via Solid Notifications
 * and publishes public activities to Stream1 (RedPanda).
 * 
 * The Aggregator is the bridge between ActivityPods' internal activity system
 * and the external streaming infrastructure.
 * 
 * Installation:
 * 1. Copy this file to your ActivityPods backend services directory
 * 2. Add kafkajs dependency to your package.json
 * 3. Configure REDPANDA_BROKERS and TOPIC_STREAM1 in your environment
 */

const { Kafka, Partitioners } = require('kafkajs');

module.exports = {
  name: 'aggregator',
  
  dependencies: ['activitypub.outbox', 'ldp.notifications'],

  settings: {
    // RedPanda configuration
    redpanda: {
      brokers: (process.env.REDPANDA_BROKERS || 'localhost:9092').split(','),
      clientId: process.env.REDPANDA_CLIENT_ID || 'activitypods-aggregator',
    },
    // Topic for local public activities
    stream1Topic: process.env.TOPIC_STREAM1 || 'stream1-local-public',
    // Topic for firehose (combined)
    firehoseTopic: process.env.TOPIC_FIREHOSE || 'firehose',
    // Public addressing URIs
    publicAddresses: [
      'https://www.w3.org/ns/activitystreams#Public',
      'as:Public',
      'Public',
    ],
  },

  created() {
    this.kafka = null;
    this.producer = null;
    this.isConnected = false;
    this.watchedActors = new Set();
  },

  async started() {
    try {
      // Initialize Kafka/RedPanda connection
      this.kafka = new Kafka({
        clientId: this.settings.redpanda.clientId,
        brokers: this.settings.redpanda.brokers,
        retry: {
          initialRetryTime: 100,
          retries: 8,
        },
      });

      this.producer = this.kafka.producer({
        createPartitioner: Partitioners.DefaultPartitioner,
        allowAutoTopicCreation: true,
      });

      await this.producer.connect();
      this.isConnected = true;
      this.logger.info('Aggregator connected to RedPanda');

      // Start watching all existing actors
      await this.watchAllActors();

    } catch (err) {
      this.logger.error('Failed to start aggregator:', err);
    }
  },

  async stopped() {
    if (this.producer) {
      await this.producer.disconnect();
    }
    this.isConnected = false;
  },

  actions: {
    /**
     * Manually trigger watching a specific actor's outbox
     * @param {Object} ctx - Moleculer context
     * @param {string} ctx.params.actorUri - The actor URI to watch
     */
    async watchActor(ctx) {
      const { actorUri } = ctx.params;
      await this.watchActorOutbox(actorUri);
      return { success: true, actorUri };
    },

    /**
     * Stop watching a specific actor's outbox
     * @param {Object} ctx - Moleculer context
     * @param {string} ctx.params.actorUri - The actor URI to stop watching
     */
    async unwatchActor(ctx) {
      const { actorUri } = ctx.params;
      this.watchedActors.delete(actorUri);
      // Note: Actual unsubscription from Solid Notifications would go here
      return { success: true, actorUri };
    },

    /**
     * Get list of watched actors
     */
    getWatchedActors() {
      return Array.from(this.watchedActors);
    },

    /**
     * Manually publish an activity to Stream1
     * Used for testing or manual intervention
     */
    async publishActivity(ctx) {
      const { actorUri, activity } = ctx.params;
      
      if (!this.isPublicActivity(activity)) {
        return { success: false, reason: 'Activity is not public' };
      }

      await this.publishToStream1(actorUri, activity);
      return { success: true };
    },

    /**
     * Health check
     */
    health() {
      return {
        status: this.isConnected ? 'healthy' : 'disconnected',
        watchedActors: this.watchedActors.size,
        timestamp: new Date().toISOString(),
      };
    },
  },

  events: {
    /**
     * Listen for new actor creation to start watching their outbox
     */
    async 'activitypub.actor.created'(ctx) {
      const { actorUri } = ctx.params;
      this.logger.info(`New actor created, starting to watch: ${actorUri}`);
      await this.watchActorOutbox(actorUri);
    },

    /**
     * Listen for actor deletion to stop watching their outbox
     */
    async 'activitypub.actor.deleted'(ctx) {
      const { actorUri } = ctx.params;
      this.logger.info(`Actor deleted, stopping watch: ${actorUri}`);
      this.watchedActors.delete(actorUri);
    },

    /**
     * Listen for outbox activity events
     * This is the primary event that triggers aggregation
     */
    async 'activitypub.outbox.post'(ctx) {
      const { activity, webId } = ctx.params;

      // Check if activity is public
      if (!this.isPublicActivity(activity)) {
        this.logger.debug(`Skipping non-public activity from ${webId}`);
        return;
      }

      // Publish to Stream1
      await this.publishToStream1(webId, activity);
    },

    /**
     * Alternative: Listen for Solid Notifications webhook events
     * Use this if you prefer webhook-based notifications over Moleculer events
     */
    async 'solid.notification.received'(ctx) {
      const { notification, resourceUri } = ctx.params;

      // Check if this is an outbox notification
      if (!resourceUri.includes('/outbox')) {
        return;
      }

      // Extract the activity from the notification
      const activity = notification.object;
      if (!activity) {
        return;
      }

      // Extract actor from outbox URI
      const actorUri = resourceUri.replace('/outbox', '');

      if (this.isPublicActivity(activity)) {
        await this.publishToStream1(actorUri, activity);
      }
    },
  },

  methods: {
    /**
     * Watch all existing actors' outboxes
     */
    async watchAllActors() {
      try {
        // Get all actors from the system
        const actors = await this.broker.call('activitypub.actor.list', {});
        
        for (const actor of actors) {
          const actorUri = actor.id || actor['@id'];
          await this.watchActorOutbox(actorUri);
        }

        this.logger.info(`Started watching ${this.watchedActors.size} actors`);
      } catch (err) {
        this.logger.error('Failed to watch all actors:', err);
      }
    },

    /**
     * Start watching a specific actor's outbox
     * @param {string} actorUri - The actor URI
     */
    async watchActorOutbox(actorUri) {
      if (this.watchedActors.has(actorUri)) {
        return; // Already watching
      }

      try {
        // Subscribe to the actor's outbox via Solid Notifications
        // This uses the Solid Notifications protocol (WebSocket or Webhook)
        await this.broker.call('ldp.notifications.subscribe', {
          resourceUri: `${actorUri}/outbox`,
          webhookUrl: process.env.AGGREGATOR_WEBHOOK_URL,
        });

        this.watchedActors.add(actorUri);
        this.logger.debug(`Started watching outbox for: ${actorUri}`);
      } catch (err) {
        this.logger.error(`Failed to watch outbox for ${actorUri}:`, err);
      }
    },

    /**
     * Check if an activity is addressed to the public
     * @param {Object} activity - The activity to check
     * @returns {boolean}
     */
    isPublicActivity(activity) {
      const checkField = (field) => {
        if (!field) return false;
        const values = Array.isArray(field) ? field : [field];
        return values.some(v => {
          const uri = typeof v === 'string' ? v : v?.id || v?.['@id'];
          return this.settings.publicAddresses.includes(uri);
        });
      };

      return checkField(activity.to) || checkField(activity.cc);
    },

    /**
     * Publish an activity to Stream1 (and Firehose)
     * @param {string} actorUri - The actor URI
     * @param {Object} activity - The activity to publish
     */
    async publishToStream1(actorUri, activity) {
      if (!this.isConnected) {
        this.logger.warn('Cannot publish: RedPanda not connected');
        return;
      }

      const message = {
        actorUri,
        activity,
        origin: 'local',
        publishedAt: new Date().toISOString(),
      };

      try {
        // Publish to Stream1
        await this.producer.send({
          topic: this.settings.stream1Topic,
          messages: [{
            key: actorUri,
            value: JSON.stringify(message),
            headers: {
              'content-type': 'application/activity+json',
              'origin': 'local',
            },
          }],
        });

        // Also publish to Firehose
        await this.producer.send({
          topic: this.settings.firehoseTopic,
          messages: [{
            key: actorUri,
            value: JSON.stringify({
              ...message,
              indexedAt: new Date().toISOString(),
            }),
            headers: {
              'content-type': 'application/activity+json',
              'origin': 'local',
            },
          }],
        });

        this.logger.debug(`Published activity from ${actorUri} to Stream1 and Firehose`);
      } catch (err) {
        this.logger.error(`Failed to publish to Stream1:`, err);
      }
    },
  },
};
