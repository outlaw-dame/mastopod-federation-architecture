/**
 * V6.5 Phase 5.5: AT Ingress Pipeline — Public API
 *
 * Barrel file exporting all public interfaces and implementations
 * for the external AT firehose intake pipeline.
 */

// Event schemas
export * from './AtIngressEvents';

// Consumer
export {
  AtFirehoseSource,
  AtFirehoseConsumer,
  DefaultAtFirehoseConsumer,
} from './AtFirehoseConsumer';

// Decoder
export {
  DecodedFirehoseHeader,
  AtFirehoseDecoder,
  DefaultAtFirehoseDecoder,
  FirehoseDecodeError,
} from './AtFirehoseDecoder';

// Cursor management
export {
  AtFirehoseCursorManager,
  DefaultAtFirehoseCursorManager,
  InMemoryAtFirehoseCursorManager,
  CursorError,
} from './AtFirehoseCursorManager';

// Checkpoint store
export {
  AtIngressCheckpointStore,
  RedisAtIngressCheckpointStore,
  InMemoryAtIngressCheckpointStore,
  CheckpointError,
} from './AtIngressCheckpointStore';

// Event classifier
export {
  AtIngressEventClassifier,
  Phase55AEventClassifier,
  Phase55BEventClassifier,
  InMemoryAtIngressEventClassifier,
  ClassifierError,
} from './AtIngressEventClassifier';

// Audit publisher
export {
  AtIngressAuditPublisher,
  DefaultAtIngressAuditPublisher,
  InMemoryAtIngressAuditPublisher,
  AT_VERIFY_FAILED_TOPIC,
} from './AtIngressAuditPublisher';

// Verifier
export {
  AtIngressVerifier,
  DefaultAtIngressVerifier,
  AtCommitVerifier,
  AtIdentityResolver,
  AtSyncRebuilder,
} from './AtIngressVerifier';

// Webhook forwarder (memory UI integration)
export {
  AtIngressWebhookForwarder,
  WebhookEndpoint,
  ForwarderResult,
} from './AtIngressWebhookForwarder';
