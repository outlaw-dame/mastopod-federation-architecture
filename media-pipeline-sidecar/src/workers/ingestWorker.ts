/**
 * DEPRECATED — this worker is a no-op relay that is kept alive only to drain
 * any messages that may remain in the legacy `media:ingest` stream from before
 * the ingress was updated to write directly to `media:fetch`.
 *
 * New ingest requests go directly to `media:fetch`; this file can be removed
 * once the `media:ingest` stream is confirmed empty in all environments.
 */

import { MediaStreams } from '../contracts/MediaStreams';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { logger } from '../logger';

runSecureWorker({
  stream: MediaStreams.INGEST,
  group: 'media',
  consumer: 'ingest-worker-1',
  handler: async (message) => {
    logger.warn(
      { traceId: message.traceId || null },
      'ingest-worker-drain-legacy-message'
    );
    await enqueue(MediaStreams.FETCH, message);
  }
});
