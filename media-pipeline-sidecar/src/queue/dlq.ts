import { MediaStreams } from '../contracts/MediaStreams';
import { redis } from './redisClient';
import { config } from '../config/config';
import { logger } from '../logger';

// Redis key that tracks the last webhook alert timestamp (prevents alert storms)
const DLQ_LAST_ALERT_KEY = 'media:dlq:last-alert-at';

export async function pushToDlq(payload: Record<string, string>): Promise<void> {
  await redis.xAdd(MediaStreams.DLQ, '*', payload, {
    TRIM: {
      strategy: 'MAXLEN',
      strategyModifier: '~',
      threshold: config.dlqMaxLen
    }
  });
  // Fire-and-forget alert check; never block the caller
  checkDlqAlertThreshold().catch((err) => {
    logger.warn({ err }, 'dlq-alert-check-failed');
  });
}

/**
 * Checks DLQ depth and fires a webhook alert when it crosses the configured
 * threshold — rate-limited to once per `dlqAlertIntervalMs`.
 */
async function checkDlqAlertThreshold(): Promise<void> {
  const webhookUrl = config.dlqAlertWebhookUrl;
  if (!webhookUrl) return;

  const length = await redis.xLen(MediaStreams.DLQ);
  if (length < config.dlqAlertThreshold) return;

  // Rate-limit: only alert if enough time has passed since the last one
  const lastAlertAt = await redis.get(DLQ_LAST_ALERT_KEY);
  const lastAlertMs = lastAlertAt ? Number(lastAlertAt) : 0;
  if (Date.now() - lastAlertMs < config.dlqAlertIntervalMs) return;

  // Set the last-alert timestamp BEFORE the HTTP call to prevent concurrent alerts
  await redis.set(DLQ_LAST_ALERT_KEY, String(Date.now()), {
    EX: Math.ceil(config.dlqAlertIntervalMs / 1000) * 2
  });

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        alert: 'media-pipeline-dlq-threshold-exceeded',
        dlqLength: length,
        threshold: config.dlqAlertThreshold,
        timestamp: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      logger.warn({ status: response.status, dlqLength: length }, 'dlq-alert-webhook-non-ok');
    } else {
      logger.info({ dlqLength: length }, 'dlq-alert-webhook-fired');
    }
  } catch (err) {
    logger.warn({ err, dlqLength: length }, 'dlq-alert-webhook-failed');
  }
}
