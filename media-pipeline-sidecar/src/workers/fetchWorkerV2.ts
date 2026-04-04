import { runSecureWorker } from '../queue/secureWorker.js';
import { MediaStreams } from '../contracts/MediaStreams.js';
import { enqueue } from '../queue/producer.js';
import { assertSafeRemoteUrl } from '../security/ssrfGuard.js';
import { checkUrlsSafe } from '../security/safeBrowsingClient.js';
import { fetch } from 'undici';
import { config } from '../config.js';

runSecureWorker({
  stream: MediaStreams.FETCH_REMOTE,
  group: 'media',
  consumer: 'fetch-worker-2',
  handler: async (msg: any) => {
    const safeUrl = await assertSafeRemoteUrl(msg.url);

    if (config.safeBrowsingApiKey) {
      const result = await checkUrlsSafe([safeUrl.toString()], config.safeBrowsingApiKey);

      if (result.threats.length > 0) {
        throw new Error(`Blocked by Safe Browsing: ${JSON.stringify(result.threats)}`);
      }
    }

    const res = await fetch(safeUrl, {
      maxRedirections: 3,
      headers: {
        'user-agent': 'media-pipeline/1.0'
      }
    });

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    await enqueue(MediaStreams.PROCESS_IMAGE, {
      bytesBase64: buffer.toString('base64'),
      traceId: msg.traceId
    });
  }
});
