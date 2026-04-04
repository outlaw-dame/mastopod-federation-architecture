import { runSecureWorker } from '../queue/secureWorker.js';
import { MediaStreams } from '../contracts/MediaStreams.js';
import { enqueue } from '../queue/producer.js';
import { assertSafeRemoteUrl } from '../security/ssrfGuard.js';
import { fetch } from 'undici';

runSecureWorker({
  stream: MediaStreams.FETCH,
  group: 'media',
  consumer: 'fetch-worker-1',
  handler: async (msg: any) => {
    const safeUrl = await assertSafeRemoteUrl(msg.url);

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
