/**
 * Domain-Batched Delivery Worker
 * 
 * Optimizes activity delivery by:
 * - Grouping recipients by domain
 * - Using shared inbox when available
 * - Connection pooling per domain
 * - Signature caching
 * - Exponential backoff retry
 */

import { Agent, fetch } from "undici";
import { createHash, createSign } from "crypto";
import pLimit from "p-limit";
import { Kafka, Consumer, EachBatchPayload } from "kafkajs";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import { metrics } from "../metrics/index.js";

// Types
interface DeliveryTask {
  actorId: string;
  activity: ActivityPayload;
  recipients: Recipient[];
  timestamp: number;
  attempt?: number;
}

interface ActivityPayload {
  "@context"?: string | string[] | object;
  id?: string;
  type: string;
  actor: string;
  object?: unknown;
  to?: string | string[];
  cc?: string | string[];
  [key: string]: unknown;
}

interface Recipient {
  id: string;
  inbox?: string;
  sharedInbox?: string;
}

interface DomainBatch {
  domain: string;
  sharedInbox: string | null;
  recipients: Recipient[];
}

interface SignatureComponents {
  signature: string;
  date: string;
  digest: string;
}

interface CachedSignature {
  components: SignatureComponents;
  expiry: number;
}

/**
 * Domain-Batched Delivery Worker
 * Consumes from activitypods.outbox and delivers with optimizations
 */
export class DomainBatchedDeliveryWorker {
  private kafka: Kafka;
  private consumer: Consumer | null = null;
  private connectionPools = new Map<string, Agent>();
  private signatureCache = new Map<string, CachedSignature>();
  private isRunning = false;

  // Rate limiting per domain
  private domainLimiters = new Map<string, ReturnType<typeof pLimit>>();
  private readonly maxConcurrentPerDomain = 5;
  private readonly maxConcurrentDomains = 50;

  constructor() {
    this.kafka = new Kafka({
      clientId: config.redpanda.clientId + "-delivery-worker",
      brokers: config.redpanda.brokers.split(","),
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });
  }

  /**
   * Start the delivery worker
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logger.info("Starting domain-batched delivery worker...");

    this.consumer = this.kafka.consumer({
      groupId: config.redpanda.clientId + "-delivery-workers",
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: "activitypods.outbox",
      fromBeginning: false,
    });

    this.isRunning = true;

    // Process in batches for efficiency
    await this.consumer.run({
      eachBatch: async (payload: EachBatchPayload) => {
        await this.processBatch(payload);
      },
    });

    logger.info("Domain-batched delivery worker started");
  }

  /**
   * Process a batch of messages from the same partition (same domain)
   */
  private async processBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, isRunning, isStale } = payload;

    const tasks: DeliveryTask[] = [];

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) {
        break;
      }

      if (!message.value) {
        continue;
      }

      try {
        const parsed = JSON.parse(message.value.toString());
        
        if (parsed.type === "DELIVER_ACTIVITY") {
          tasks.push({
            actorId: parsed.actorId,
            activity: parsed.activity,
            recipients: parsed.recipients,
            timestamp: parsed.timestamp,
            attempt: parsed.attempt ?? 1,
          });
        }
      } catch (error) {
        logger.error("Failed to parse delivery task", { error });
      }

      resolveOffset(message.offset);
      await heartbeat();
    }

    // Process all tasks in this batch
    if (tasks.length > 0) {
      await this.processDeliveryTasks(tasks);
    }
  }

  /**
   * Process multiple delivery tasks, consolidating by domain
   */
  private async processDeliveryTasks(tasks: DeliveryTask[]): Promise<void> {
    const startTime = Date.now();
    
    // Consolidate all recipients across tasks by domain
    const domainBatches = new Map<string, {
      tasks: DeliveryTask[];
      batch: DomainBatch;
    }>();

    for (const task of tasks) {
      const taskBatches = this.groupByDomain(task.recipients);

      for (const [domain, batch] of taskBatches) {
        if (!domainBatches.has(domain)) {
          domainBatches.set(domain, {
            tasks: [],
            batch: {
              domain,
              sharedInbox: batch.sharedInbox,
              recipients: [],
            },
          });
        }

        const existing = domainBatches.get(domain)!;
        existing.tasks.push(task);
        existing.batch.recipients.push(...batch.recipients);

        // Update shared inbox if found
        if (batch.sharedInbox && !existing.batch.sharedInbox) {
          existing.batch.sharedInbox = batch.sharedInbox;
        }
      }
    }

    // Limit concurrent domain deliveries
    const domainLimit = pLimit(this.maxConcurrentDomains);
    const deliveryPromises: Promise<void>[] = [];

    for (const [domain, { tasks: domainTasks, batch }] of domainBatches) {
      deliveryPromises.push(
        domainLimit(async () => {
          // Each task in this domain batch needs its own delivery
          for (const task of domainTasks) {
            const taskRecipients = task.recipients.filter(r => {
              const recipientDomain = this.extractDomain(r.inbox ?? r.id);
              return recipientDomain === domain;
            });

            if (taskRecipients.length > 0) {
              await this.deliverToDomain(
                task.activity,
                task.actorId,
                {
                  domain,
                  sharedInbox: batch.sharedInbox,
                  recipients: taskRecipients,
                }
              );
            }
          }
        })
      );
    }

    await Promise.allSettled(deliveryPromises);

    const duration = Date.now() - startTime;
    logger.info("Batch delivery completed", {
      taskCount: tasks.length,
      domainCount: domainBatches.size,
      durationMs: duration,
    });

    metrics.batchDeliveryDuration.observe(duration / 1000);
  }

  /**
   * Group recipients by domain
   */
  private groupByDomain(recipients: Recipient[]): Map<string, DomainBatch> {
    const batches = new Map<string, DomainBatch>();

    for (const recipient of recipients) {
      const inbox = recipient.inbox ?? recipient.id;
      const domain = this.extractDomain(inbox);

      if (!domain) {
        logger.warn("Could not extract domain from recipient", { recipient });
        continue;
      }

      if (!batches.has(domain)) {
        batches.set(domain, {
          domain,
          sharedInbox: null,
          recipients: [],
        });
      }

      const batch = batches.get(domain)!;
      batch.recipients.push(recipient);

      // Check for shared inbox
      if (recipient.sharedInbox && !batch.sharedInbox) {
        batch.sharedInbox = recipient.sharedInbox;
      }
    }

    return batches;
  }

  /**
   * Deliver activity to a domain (using shared inbox or individual inboxes)
   */
  private async deliverToDomain(
    activity: ActivityPayload,
    actorId: string,
    batch: DomainBatch
  ): Promise<void> {
    const { domain, sharedInbox, recipients } = batch;

    // Use shared inbox if available and multiple recipients
    if (sharedInbox && recipients.length > 1) {
      await this.deliverToSharedInbox(activity, actorId, sharedInbox, recipients);
      
      // Track optimization
      metrics.deliveriesOptimized.inc(
        { domain, type: "shared_inbox" },
        recipients.length - 1
      );
    } else {
      // Individual delivery with connection reuse
      await this.deliverToIndividualInboxes(activity, actorId, recipients, domain);
    }
  }

  /**
   * Deliver to shared inbox (single HTTP request for multiple recipients)
   */
  private async deliverToSharedInbox(
    activity: ActivityPayload,
    actorId: string,
    sharedInbox: string,
    recipients: Recipient[]
  ): Promise<void> {
    const domain = this.extractDomain(sharedInbox);
    const pool = this.getOrCreatePool(domain);
    const startTime = Date.now();

    try {
      const signatureComponents = await this.getSignatureComponents(
        actorId,
        activity,
        sharedInbox,
        "POST"
      );

      const response = await fetch(sharedInbox, {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          "Accept": "application/activity+json, application/ld+json",
          "Date": signatureComponents.date,
          "Digest": signatureComponents.digest,
          "Signature": signatureComponents.signature,
          "User-Agent": `ActivityPods-Fedify-Sidecar/${config.version}`,
        },
        body: JSON.stringify(activity),
        dispatcher: pool,
      });

      const duration = Date.now() - startTime;

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      logger.debug("Shared inbox delivery successful", {
        sharedInbox,
        recipientCount: recipients.length,
        durationMs: duration,
      });

      metrics.deliveryLatency.observe(
        { domain, type: "shared_inbox", status: "success" },
        duration / 1000
      );
      metrics.deliveriesTotal.inc(
        { domain, type: "shared_inbox", status: "success" }
      );

    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Shared inbox delivery failed", {
        sharedInbox,
        error,
        durationMs: duration,
      });

      metrics.deliveryLatency.observe(
        { domain, type: "shared_inbox", status: "error" },
        duration / 1000
      );
      metrics.deliveriesTotal.inc(
        { domain, type: "shared_inbox", status: "error" }
      );

      throw error;
    }
  }

  /**
   * Deliver to individual inboxes with connection reuse
   */
  private async deliverToIndividualInboxes(
    activity: ActivityPayload,
    actorId: string,
    recipients: Recipient[],
    domain: string
  ): Promise<void> {
    const pool = this.getOrCreatePool(domain);
    const limiter = this.getDomainLimiter(domain);

    await Promise.all(
      recipients.map((recipient) =>
        limiter(async () => {
          const inbox = recipient.inbox ?? recipient.id;
          const startTime = Date.now();

          try {
            const signatureComponents = await this.getSignatureComponents(
              actorId,
              activity,
              inbox,
              "POST"
            );

            const response = await fetch(inbox, {
              method: "POST",
              headers: {
                "Content-Type": "application/activity+json",
                "Accept": "application/activity+json, application/ld+json",
                "Date": signatureComponents.date,
                "Digest": signatureComponents.digest,
                "Signature": signatureComponents.signature,
                "User-Agent": `ActivityPods-Fedify-Sidecar/${config.version}`,
              },
              body: JSON.stringify(activity),
              dispatcher: pool,
            });

            const duration = Date.now() - startTime;

            if (!response.ok) {
              const body = await response.text();
              throw new Error(`HTTP ${response.status}: ${body}`);
            }

            logger.debug("Individual inbox delivery successful", {
              inbox,
              durationMs: duration,
            });

            metrics.deliveryLatency.observe(
              { domain, type: "individual", status: "success" },
              duration / 1000
            );
            metrics.deliveriesTotal.inc(
              { domain, type: "individual", status: "success" }
            );

          } catch (error) {
            const duration = Date.now() - startTime;

            logger.warn("Individual inbox delivery failed", {
              inbox,
              error,
              durationMs: duration,
            });

            metrics.deliveryLatency.observe(
              { domain, type: "individual", status: "error" },
              duration / 1000
            );
            metrics.deliveriesTotal.inc(
              { domain, type: "individual", status: "error" }
            );

            throw error;
          }
        })
      )
    );
  }

  /**
   * Get or create connection pool for a domain
   */
  private getOrCreatePool(domain: string): Agent {
    if (!this.connectionPools.has(domain)) {
      this.connectionPools.set(
        domain,
        new Agent({
          connect: {
            keepAlive: true,
            keepAliveInitialDelay: 1000,
            keepAliveMaxTimeout: 30000,
          },
          connections: 10,
          pipelining: 1,
        })
      );
    }
    return this.connectionPools.get(domain)!;
  }

  /**
   * Get rate limiter for a domain
   */
  private getDomainLimiter(domain: string): ReturnType<typeof pLimit> {
    if (!this.domainLimiters.has(domain)) {
      this.domainLimiters.set(domain, pLimit(this.maxConcurrentPerDomain));
    }
    return this.domainLimiters.get(domain)!;
  }

  /**
   * Get signature components (with caching)
   */
  private async getSignatureComponents(
    actorId: string,
    activity: ActivityPayload,
    targetUrl: string,
    method: string
  ): Promise<SignatureComponents> {
    const body = JSON.stringify(activity);
    const cacheKey = `${actorId}:${body}:${targetUrl}`;
    
    const cached = this.signatureCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      metrics.signatureCacheHits.inc();
      return cached.components;
    }

    metrics.signatureCacheMisses.inc();

    // Generate new signature
    const date = new Date().toUTCString();
    const digest = this.computeDigest(body);
    const signature = await this.generateSignature(
      actorId,
      targetUrl,
      method,
      date,
      digest
    );

    const components: SignatureComponents = { signature, date, digest };

    // Cache for 5 minutes
    this.signatureCache.set(cacheKey, {
      components,
      expiry: Date.now() + 5 * 60 * 1000,
    });

    return components;
  }

  /**
   * Compute SHA-256 digest of body
   */
  private computeDigest(body: string): string {
    const hash = createHash("sha256").update(body).digest("base64");
    return `SHA-256=${hash}`;
  }

  /**
   * Generate HTTP signature
   * In production, this should call the ActivityPods signing API
   */
  private async generateSignature(
    actorId: string,
    targetUrl: string,
    method: string,
    date: string,
    digest: string
  ): Promise<string> {
    const url = new URL(targetUrl);
    const keyId = `${actorId}#main-key`;

    // Build the signing string
    const signingString = [
      `(request-target): ${method.toLowerCase()} ${url.pathname}`,
      `host: ${url.host}`,
      `date: ${date}`,
      `digest: ${digest}`,
    ].join("\n");

    // In production, call the signing API
    // For now, return a placeholder that will be replaced
    // when the signing service is properly integrated
    
    // TODO: Call config.activitypods.signingApiUrl to get actual signature
    const signatureValue = await this.callSigningApi(actorId, signingString);

    return `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signatureValue}"`;
  }

  /**
   * Call the ActivityPods signing API
   */
  private async callSigningApi(
    actorId: string,
    signingString: string
  ): Promise<string> {
    try {
      const response = await fetch(config.activitypods.signingApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Request": "true",
        },
        body: JSON.stringify({
          actorId,
          signingString,
        }),
      });

      if (!response.ok) {
        throw new Error(`Signing API returned ${response.status}`);
      }

      const result = await response.json() as { signature: string };
      return result.signature;
    } catch (error) {
      logger.error("Failed to call signing API", { actorId, error });
      throw error;
    }
  }

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  /**
   * Stop the delivery worker
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info("Stopping domain-batched delivery worker...");

    this.isRunning = false;

    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = null;
    }

    // Close connection pools
    for (const pool of this.connectionPools.values()) {
      await pool.close();
    }
    this.connectionPools.clear();

    logger.info("Domain-batched delivery worker stopped");
  }
}

// Export singleton instance
export const deliveryWorker = new DomainBatchedDeliveryWorker();
