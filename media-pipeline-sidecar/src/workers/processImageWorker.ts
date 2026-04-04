import { runWorker } from '../queue/worker.js';
import { MediaStreams } from '../contracts/MediaStreams.js';
import { processImage, sha256 } from '../processing.js';
import { uploadObject } from '../storage.js';

runWorker({
  stream: MediaStreams.PROCESS_IMAGE,
  group: 'media',
  consumer: 'image-worker-1',
  handler: async (msg) => {
    const bytes = Buffer.from(msg.bytesBase64, 'base64');
    const processed = await processImage(bytes);
    const hash = sha256(processed.webp);

    await uploadObject(`${hash}.webp`, processed.webp, 'image/webp');
  }
});
