import { runSecureWorker } from '../queue/secureWorker.js';
import { MediaStreams } from '../contracts/MediaStreams.js';
import { processImage, sha256 } from '../processing.js';
import { uploadObject } from '../storage.js';
import { enqueue } from '../queue/producer.js';
import { redis } from '../queue/redisClient.js';

runSecureWorker({
  stream: MediaStreams.PROCESS_IMAGE,
  group: 'media',
  consumer: 'image-worker-2',
  handler: async (msg: any) => {
    const bytes = Buffer.from(msg.bytesBase64, 'base64');

    const processed = await processImage(bytes);
    const hash = sha256(processed.webp);

    const dedupeKey = `media:hash:${hash}`;
    const exists = await redis.get(dedupeKey);
    if (exists) return;

    await redis.set(dedupeKey, '1', { EX: 86400 });

    const key = `${hash}.webp`;
    const url = await uploadObject(key, processed.webp, 'image/webp');

    await enqueue(MediaStreams.FINALIZE, {
      asset: JSON.stringify({
        hash,
        url,
        mimeType: 'image/webp',
        size: processed.webp.length,
        traceId: msg.traceId
      })
    });
  }
});
