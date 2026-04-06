import { fetch } from 'undici';
import { config } from '../config/config';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { SafetySignal } from '../adapters/safetySignals';
import { retryAsync } from '../utils/retry';

export async function indexMediaAsset(asset: CanonicalAsset, signals: SafetySignal[]): Promise<void> {
  const payload = {
    assetId: asset.assetId,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
    labels: [...new Set(signals.flatMap((signal) => signal.labels))]
  };

  await retryAsync(async () => {
    const res = await fetch(`${config.opensearchUrl}/media-assets/_doc/${asset.assetId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });

    if (res.status >= 500 || res.status === 429) {
      throw new Error(`Transient OpenSearch indexing failure: ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`OpenSearch indexing failed: ${await res.text()}`);
    }
  }, {
    retries: 3,
    baseDelayMs: 400,
    maxDelayMs: 4000
  });
}
