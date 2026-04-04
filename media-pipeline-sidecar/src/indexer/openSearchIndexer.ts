import { fetch } from 'undici';

const OPENSEARCH_URL = process.env.OPENSEARCH_URL || 'http://localhost:9200';
const INDEX = 'media-assets';

export async function indexAsset(asset: any) {
  const res = await fetch(`${OPENSEARCH_URL}/${INDEX}/_doc/${asset.hash}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(asset)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSearch indexing failed: ${text}`);
  }
}

export async function bulkIndex(assets: any[]) {
  const body = assets.flatMap(doc => [
    JSON.stringify({ index: { _index: INDEX, _id: doc.hash } }),
    JSON.stringify(doc)
  ]).join('\n') + '\n';

  const res = await fetch(`${OPENSEARCH_URL}/_bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSearch bulk failed: ${text}`);
  }
}
