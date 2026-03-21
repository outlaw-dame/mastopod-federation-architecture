/**
 * RedPanda MessageQueue Implementation for Fedify
 * 
 * This implements Fedify's MessageQueue interface using RedPanda (Kafka-compatible)
 * as the backing message broker. This provides:
 * - Persistent message storage
 * - Guaranteed delivery (at-least-once)
 * - Consumer group coordination
 * - Backpressure handling
 * - Horizontal scaling
 */

import { MessageQueue, MessageQueueEnqueueOptions } from "@fedify/fedify";
import { Kafka, Producer, Consumer, EachMessagePayload, Admin, CompressionTypes } from "kafkajs";
import { logger } from "../utils/logger.js";

export interface RedPandaMessageQueueOptions {
  brokers: string[];
  clientId: string;
  consumerGroupId?: string;
  topics?: {
    outbox?: string;
    inbox?: string;
    deliveryResults?: string;
  };
  compression?: CompressionTypes;
  retryOptions?: {
    initialRetryTime?: number;
    retries?: number;
    maxRetryTime?: number;
    multiplier?: number;
  };
}

interface QueueMessage {
  type: "outbox" | "inbox" | "delivery-result";
  payload: unknown;
  metadata: {
    actorId?: string;
    targetDomain?: string;
    enqueuedAt: number;
    delayUntil?: number;
    attempt?: number;
  };
}

export class RedPandaMessageQueue implements MessageQueue {
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer | null = null;
  private admin: Admin;
  private isInitialized = false;
  private messageHandler: ((message: object) => Promise<void>) | null = null;
  
  private readonly topics: {
    outbox: string;
    inbox: string;
    deliveryResults: string;
  };

  constructor(private options: RedPandaMessageQueueOptions) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      retry: {
        initialRetryTime: options.retryOptions?.initialRetryTime ?? 100,
        retries: options.retryOptions?.retries ?? 8,
        maxRetryTime: options.retryOptions?.maxRetryTime ?? 30000,
        multiplier: options.retryOptions?.multiplier ?? 2,
      },
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });

    this.admin = this.kafka.admin();

    this.topics = {
      outbox: options.topics?.outbox ?? "activitypods.outbox",
      inbox: options.topics?.inbox ?? "activitypods.inbox",
      deliveryResults: options.topics?.deliveryResults ?? "activitypods.delivery-results",
    };
  }

  /**
   * Initialize the message queue - connect producer and create topics
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    logger.info("Initializing RedPanda message queue...");

    try {
      await this.admin.connect();
      await this.producer.connect();

      // Create topics if they don't exist
      await this.ensureTopicsExist();

      this.isInitialized = true;
      logger.info("RedPanda message queue initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize RedPanda message queue", { error });
      throw error;
    }
  }

  /**
   * Ensure all required topics exist
   */
  private async ensureTopicsExist(): Promise<void> {
    const existingTopics = await this.admin.listTopics();
    const requiredTopics = Object.values(this.topics);
    const missingTopics = requiredTopics.filter(t => !existingTopics.includes(t));

    if (missingTopics.length > 0) {
      logger.info("Creating missing topics", { topics: missingTopics });
      
      await this.admin.createTopics({
        topics: missingTopics.map(topic => ({
          topic,
          numPartitions: this.getPartitionCount(topic),
          replicationFactor: 1, // Adjust for production
          configEntries: [
            { name: "retention.ms", value: "604800000" }, // 7 days
            { name: "cleanup.policy", value: "delete" },
          ],
        })),
      });
    }
  }

  /**
   * Get partition count based on topic type
   */
  private getPartitionCount(topic: string): number {
    // More partitions for outbox to enable parallel delivery by domain
    if (topic === this.topics.outbox) {
      return 16;
    }
    return 4;
  }

  /**
   * Enqueue a message for processing
   * This is called by Fedify when activities need to be delivered
   */
  async enqueue(
    message: object,
    options?: MessageQueueEnqueueOptions
  ): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const queueMessage: QueueMessage = {
      type: this.getMessageType(message),
      payload: message,
      metadata: {
        actorId: this.extractActorId(message),
        targetDomain: this.extractTargetDomain(message),
        enqueuedAt: Date.now(),
        delayUntil: options?.delay ? Date.now() + options.delay : undefined,
        attempt: 1,
      },
    };

    const topic = this.getTopicForMessage(queueMessage);
    const key = this.getPartitionKey(queueMessage);

    try {
      await this.producer.send({
        topic,
        compression: this.options.compression ?? CompressionTypes.Snappy,
        messages: [{
          key,
          value: JSON.stringify(queueMessage),
          headers: {
            "x-message-type": queueMessage.type,
            "x-enqueued-at": String(queueMessage.metadata.enqueuedAt),
            ...(queueMessage.metadata.delayUntil && {
              "x-delay-until": String(queueMessage.metadata.delayUntil),
            }),
          },
        }],
      });

      logger.debug("Message enqueued", {
        topic,
        type: queueMessage.type,
        actorId: queueMessage.metadata.actorId,
        targetDomain: queueMessage.metadata.targetDomain,
      });
    } catch (error) {
      logger.error("Failed to enqueue message", { error, topic });
      throw error;
    }
  }

  /**
   * Start listening for messages
   * This is called by Fedify to start processing queued activities
   */
  async listen(
    handler: (message: object) => Promise<void>
  ): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    this.messageHandler = handler;

    const groupId = this.options.consumerGroupId ?? `${this.options.clientId}-consumer`;
    
    this.consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      maxBytesPerPartition: 1048576, // 1MB
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    await this.consumer.connect();

    // Subscribe to outbox and inbox topics
    await this.consumer.subscribe({
      topics: [this.topics.outbox, this.topics.inbox],
      fromBeginning: false,
    });

    logger.info("Starting message consumer", { groupId });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.processMessage(payload);
      },
    });
  }

  /**
   * Process a single message from the queue
   */
  private async processMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    
    if (!message.value) {
      logger.warn("Received empty message", { topic, partition });
      return;
    }

    let queueMessage: QueueMessage;
    
    try {
      queueMessage = JSON.parse(message.value.toString());
    } catch (error) {
      logger.error("Failed to parse message", { error, topic, partition });
      return;
    }

    // Check for delayed messages
    if (queueMessage.metadata.delayUntil) {
      const now = Date.now();
      const delayUntil = queueMessage.metadata.delayUntil;

      if (now < delayUntil) {
        // Re-enqueue with remaining delay
        const remainingDelay = delayUntil - now;
        logger.debug("Message delayed, re-enqueueing", { remainingDelay });
        
        await this.enqueue(queueMessage.payload as object, { delay: remainingDelay });
        return;
      }
    }

    // Process the message
    try {
      if (this.messageHandler) {
        await this.messageHandler(queueMessage.payload as object);
      }
      
      logger.debug("Message processed successfully", {
        topic,
        type: queueMessage.type,
        actorId: queueMessage.metadata.actorId,
      });
    } catch (error) {
      logger.error("Failed to process message", {
        error,
        topic,
        type: queueMessage.type,
        attempt: queueMessage.metadata.attempt,
      });

      // Re-enqueue with exponential backoff for retries
      const attempt = (queueMessage.metadata.attempt ?? 1) + 1;
      
      if (attempt <= 8) {
        const delay = this.calculateBackoff(attempt);
        queueMessage.metadata.attempt = attempt;
        queueMessage.metadata.delayUntil = Date.now() + delay;
        
        await this.producer.send({
          topic,
          messages: [{
            key: this.getPartitionKey(queueMessage),
            value: JSON.stringify(queueMessage),
          }],
        });
        
        logger.info("Message re-enqueued for retry", { attempt, delay });
      } else {
        // Send to dead letter queue or log permanently
        logger.error("Message exceeded max retries, dropping", {
          type: queueMessage.type,
          actorId: queueMessage.metadata.actorId,
        });
      }
    }
  }

  /**
   * Calculate exponential backoff delay
   * Formula: (attempt^4) + 15 + random(0, 30 * attempt)
   */
  private calculateBackoff(attempt: number): number {
    return Math.pow(attempt, 4) * 1000 + 15000 + Math.random() * 30000 * attempt;
  }

  /**
   * Determine message type from payload
   */
  private getMessageType(message: object): QueueMessage["type"] {
    const msg = message as Record<string, unknown>;
    
    if (msg.type === "outbox" || msg.recipients) {
      return "outbox";
    } else if (msg.type === "inbox" || msg.activity) {
      return "inbox";
    }
    return "outbox"; // Default
  }

  /**
   * Get the appropriate topic for a message
   */
  private getTopicForMessage(message: QueueMessage): string {
    switch (message.type) {
      case "outbox":
        return this.topics.outbox;
      case "inbox":
        return this.topics.inbox;
      case "delivery-result":
        return this.topics.deliveryResults;
      default:
        return this.topics.outbox;
    }
  }

  /**
   * Get partition key for message ordering/batching
   * - Outbox messages: partition by target domain (for domain batching)
   * - Inbox messages: partition by actor (for ordering)
   */
  private getPartitionKey(message: QueueMessage): string {
    if (message.type === "outbox" && message.metadata.targetDomain) {
      return message.metadata.targetDomain;
    }
    return message.metadata.actorId ?? "default";
  }

  /**
   * Extract actor ID from message payload
   */
  private extractActorId(message: object): string | undefined {
    const msg = message as Record<string, unknown>;
    return (msg.actorId as string) ?? (msg.actor as string);
  }

  /**
   * Extract target domain from message payload (for outbox messages)
   */
  private extractTargetDomain(message: object): string | undefined {
    const msg = message as Record<string, unknown>;
    const recipients = msg.recipients as Array<{ inbox?: string; id?: string }> | undefined;
    
    if (recipients && recipients.length > 0) {
      const firstRecipient = recipients[0];
      const url = firstRecipient.inbox ?? firstRecipient.id;
      
      if (url) {
        try {
          return new URL(url).hostname;
        } catch {
          return undefined;
        }
      }
    }
    
    return undefined;
  }

  /**
   * Gracefully close all connections
   */
  async close(): Promise<void> {
    logger.info("Closing RedPanda message queue...");

    try {
      if (this.consumer) {
        await this.consumer.disconnect();
      }
      await this.producer.disconnect();
      await this.admin.disconnect();
      
      this.isInitialized = false;
      logger.info("RedPanda message queue closed");
    } catch (error) {
      logger.error("Error closing RedPanda message queue", { error });
      throw error;
    }
  }
}

/**
 * Factory function to create a RedPanda message queue
 */
export function createRedPandaMessageQueue(
  brokers: string | string[],
  clientId: string = "fedify-sidecar"
): RedPandaMessageQueue {
  const brokerList = typeof brokers === "string" 
    ? brokers.split(",").map(b => b.trim())
    : brokers;

  return new RedPandaMessageQueue({
    brokers: brokerList,
    clientId,
    compression: CompressionTypes.Snappy,
    retryOptions: {
      initialRetryTime: 100,
      retries: 8,
      maxRetryTime: 30000,
      multiplier: 2,
    },
  });
}
