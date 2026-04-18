import { fetch } from 'undici';
import { config } from '../config/config';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { SafetySignal } from '../adapters/safetySignals';
import { NonRetryableMediaPipelineError, RetryableMediaPipelineError, isLikelyTransientError } from '../utils/errorHandling';
import { retryAsync } from '../utils/retry';

export interface MediaAssetIndexRequest {
  asset: CanonicalAsset;
  signals: SafetySignal[];
}

function buildIndexDocument(asset: CanonicalAsset, signals: SafetySignal[]): Record<string, unknown> {
  return {
    assetId: asset.assetId,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
    lastSeenAt: asset.lastSeenAt || asset.createdAt,
    ingestCount: asset.ingestCount ?? 1,
    playbackVariantCount: asset.variants.playback?.length || 0,
    playbackVariantWidths: asset.variants.playback?.flatMap((variant) => typeof variant.width === 'number' ? [variant.width] : []) || [],
    streamingManifestCount: asset.variants.streaming?.length || 0,
    streamingProtocols: asset.variants.streaming?.map((manifest) => manifest.protocol) || [],
    streamingVariantCount: asset.variants.streaming?.reduce((count, manifest) => count + manifest.variants.length, 0) || 0,
    labels: [...new Set(signals.flatMap((signal) => signal.labels))]
  };
}

export async function indexMediaAsset(asset: CanonicalAsset, signals: SafetySignal[]): Promise<void> {
  await indexMediaAssets([{ asset, signals }]);
}

export async function indexMediaAssets(items: MediaAssetIndexRequest[]): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const payload = items
    .map(({ asset, signals }) => [
      JSON.stringify({ index: { _index: 'media-assets', _id: asset.assetId } }),
      JSON.stringify(buildIndexDocument(asset, signals))
    ].join('\n'))
    .join('\n') + '\n';

  await retryAsync(async () => {
    const res = await fetch(`${config.opensearchUrl}/_bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: payload,
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });

    if (res.status >= 500 || res.status === 429) {
      throw new RetryableMediaPipelineError({
        code: 'OPENSEARCH_TRANSIENT_FAILURE',
        message: `Transient OpenSearch indexing failure: ${res.status}`,
        statusCode: res.status
      });
    }
    if (!res.ok) {
      throw new NonRetryableMediaPipelineError({
        code: 'OPENSEARCH_INDEX_REJECTED',
        message: `OpenSearch indexing failed: ${await res.text()}`,
        statusCode: res.status
      });
    }

    const json = await res.json() as {
      errors?: boolean;
      items?: Array<{ index?: { _id?: string; status?: number; error?: { reason?: string } } }>;
    };
    if (json.errors) {
      const failures = (json.items || [])
        .flatMap((item) => {
          const indexError = item.index;
          if (!indexError?.error) {
            return [];
          }

          return [{
            id: indexError._id || 'unknown',
            status: indexError.status || 0,
            reason: indexError.error.reason || 'unknown'
          }];
        });

      throw new NonRetryableMediaPipelineError({
        code: 'OPENSEARCH_BULK_PARTIAL_FAILURE',
        message: `OpenSearch bulk indexing failed for ${failures.length} document(s): ${failures.map((failure) => `${failure.id}:${failure.status}`).join(', ')}`
      });
    }
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000,
    shouldRetry: isLikelyTransientError
  });
}
