import { MediaStreams } from '../contracts/MediaStreams';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
runSecureWorker({
  stream: MediaStreams.INGEST,
  group: 'media',
  consumer: 'ingest-worker-1',
  handler: async (message) => {
    await enqueue(MediaStreams.FETCH, message);
  }
});
