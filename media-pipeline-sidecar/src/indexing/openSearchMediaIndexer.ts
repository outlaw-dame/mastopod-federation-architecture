import { fetch } from 'undici';
import { config } from '../config/config';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { SafetySignal } from '../adapters/safetySignals';

export async function indexMediaAsset(asset: CanonicalAsset, signals: SafetySignal[]): Promise<void> {
  const payload = {
    assetId: asset.assetId,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
    labels: signals.flatMap((signal) => signal.labels)
  };

  const res = await fetch(`${config.opensearchUrl}/media-assets/_doc/${asset.assetId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`OpenSearch indexing failed: ${await res.text()}`);
  }
}
