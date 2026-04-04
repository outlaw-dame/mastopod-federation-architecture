import { request } from 'undici';
import { config } from './config.js';

export async function fetchMedia(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await request(url, { maxRedirections: 3 });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Fetch failed: ${res.statusCode}`);
  }

  const buf = await res.body.arrayBuffer();
  if (buf.byteLength > config.maxDownloadBytes) {
    throw new Error('Max size exceeded');
  }

  return {
    bytes: new Uint8Array(buf),
    mime: res.headers['content-type'] || 'application/octet-stream'
  };
}
