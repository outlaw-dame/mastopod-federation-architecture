import { fetch } from 'undici';

export async function analyzeVideoExplicitContent(params: {
  gcsUri: string;
  accessToken: string;
}) {
  const res = await fetch('https://videointelligence.googleapis.com/v1/videos:annotate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      inputUri: params.gcsUri,
      features: ['EXPLICIT_CONTENT_DETECTION']
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Video Intelligence error: ${text}`);
  }

  return res.json();
}
