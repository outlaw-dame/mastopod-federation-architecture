import { runSecureWorker } from '../queue/secureWorker.js';
import { MediaStreams } from '../contracts/MediaStreams.js';
import { publish } from '../events/redpandaProducer.js';
import { MediaEvents } from '../contracts/MediaEvents.js';

runSecureWorker({
  stream: MediaStreams.FINALIZE,
  group: 'media',
  consumer: 'finalize-worker-1',
  handler: async (msg: any) => {
    const asset = JSON.parse(msg.asset);

    await publish(MediaEvents.ASSET_CREATED, asset);
  }
});
