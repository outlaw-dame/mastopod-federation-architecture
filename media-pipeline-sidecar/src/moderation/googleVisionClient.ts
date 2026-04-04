import { fetch } from 'undici';

export async function analyzeImageWithGoogleVision(params: {
  base64Image: string;
  apiKey: string;
}) {
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${params.apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { content: params.base64Image },
          features: [{ type: 'SAFE_SEARCH_DETECTION' }]
        }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vision API error: ${text}`);
  }

  const json = await res.json();
  const annotation = json.responses?.[0]?.safeSearchAnnotation;

  return annotation;
}
