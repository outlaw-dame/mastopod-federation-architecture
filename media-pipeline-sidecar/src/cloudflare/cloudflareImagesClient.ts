import { fetch } from 'undici';
import FormData from 'form-data';

export async function uploadToCloudflareImages(params: {
  accountId: string;
  apiToken: string;
  file: Buffer;
  filename: string;
}) {
  const form = new FormData();
  form.append('file', params.file, params.filename);

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${params.accountId}/images/v1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiToken}`
    },
    body: form as any
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare Images upload failed: ${text}`);
  }

  const json = await res.json();

  return json.result;
}
