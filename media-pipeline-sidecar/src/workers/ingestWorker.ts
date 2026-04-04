import { runSecureWorker } from '../queue/secureWorker.js';
import { MediaStreams } from '../contracts/MediaStreams.js';
import { enqueue } from '../queue/producer.js';

runSecureWorker({
  stream: MediaStreams.INGEST,
  group: 'media',
  consumer: 'ingest-worker-1',
  handler: async (msg: any) => {
    // Pass directly to fetch stage
    await enqueue(MediaStreams.FETCH, {
      url: msg.url,
      traceId: msg.traceId
    });
  }
});
