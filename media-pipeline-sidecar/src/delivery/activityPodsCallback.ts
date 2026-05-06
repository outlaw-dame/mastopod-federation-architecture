import { config } from '../config/config';
import { logger } from '../logger';
import { retryAsync } from '../utils/retry';
import { RetryableMediaPipelineError, NonRetryableMediaPipelineError, isLikelyTransientError } from '../utils/errorHandling';
import type { CanonicalAsset } from '../contracts/CanonicalAsset';
import type { parseSafetySignals } from '../adapters/safetySignals';
import type { projectToActivityPubMedia } from '../projection/activitypubMedia';

export interface ActivityPodsCallbackPayload {
  asset: CanonicalAsset;
  signals: ReturnType<typeof parseSafetySignals>;
  bindings: { activitypub: ReturnType<typeof projectToActivityPubMedia> };
}

/**
 * Delivers processed media asset results to ActivityPods via HTTP callback.
 * This is the PRIMARY delivery path (Redpanda is supplementary).
 *
 * - Uses full-jitter exponential backoff on transient failures.
 * - 409 Conflict is treated as success (idempotent re-delivery).
 * - Does NOT throw after exhausted retries — caller must handle via try/catch.
 */
export async function deliverAssetToActivityPods(payload: ActivityPodsCallbackPayload): Promise<void> {
  const url = config.activityPodsCallbackUrl;
  const token = config.activityPodsCallbackToken;

  if (!config.activityPodsCallbackEnabled || !url || !token) {
    return;
  }

  const body = JSON.stringify(payload);

  await retryAsync(
    async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          body,
          signal: AbortSignal.timeout(config.activityPodsCallbackTimeoutMs)
        });
      } catch (networkErr) {
        // Network or timeout — always retryable
        throw new RetryableMediaPipelineError({
          code: 'AP_CALLBACK_NETWORK_ERROR',
          message: networkErr instanceof Error ? networkErr.message : String(networkErr),
          cause: networkErr
        });
      }

      // 409 = already received (idempotent) — treat as success
      if (response.ok || response.status === 409) {
        logger.debug(
          { assetId: payload.asset.assetId, status: response.status },
          'ap-callback-delivered'
        );
        return;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable) {
        throw new RetryableMediaPipelineError({
          code: 'AP_CALLBACK_HTTP_ERROR',
          message: `ActivityPods callback returned HTTP ${response.status}`,
          statusCode: response.status
        });
      }

      throw new NonRetryableMediaPipelineError({
        code: 'AP_CALLBACK_HTTP_REJECTED',
        message: `ActivityPods callback rejected with HTTP ${response.status}`,
        statusCode: response.status
      });
    },
    {
      retries: config.activityPodsCallbackMaxRetries,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      shouldRetry: isLikelyTransientError
    }
  );
}
