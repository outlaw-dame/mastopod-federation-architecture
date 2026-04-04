import { runSecureWorker } from '../queue/secureWorker.js';
import { MediaStreams } from '../contracts/MediaStreams.js';
import { publish } from '../events/redpandaProducer.js';
import { MediaEvents } from '../contracts/MediaEvents.js';
import { saveAsset } from '../persistence/assetStore.js';
import { indexAsset } from '../indexer/openSearchIndexer.js';

runSecureWorker({
  stream: MediaStreams.FINALIZE,
  group: 'media',
  consumer: 'finalize-worker-2',
  handler: async (msg: any) => {
    const asset = JSON.parse(msg.asset);

    const saved = await saveAsset(asset);

    await indexAsset(saved);

    await publish(MediaEvents.ASSET_CREATED, saved);
  }
});
