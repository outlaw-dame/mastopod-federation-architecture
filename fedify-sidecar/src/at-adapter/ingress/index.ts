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
  DefaultAtFirehoseConsumer,
} from './AtFirehoseConsumer';
export type {
  AtFirehoseSource,
  AtFirehoseConsumer,
} from './AtFirehoseConsumer';

// Decoder
export {
  DefaultAtFirehoseDecoder,
  FirehoseDecodeError,
} from './AtFirehoseDecoder';
export type {
  DecodedFirehoseHeader,
  AtFirehoseDecoder,
} from './AtFirehoseDecoder';

// Cursor management
export {
  DefaultAtFirehoseCursorManager,
  InMemoryAtFirehoseCursorManager,
  CursorError,
} from './AtFirehoseCursorManager';
export type {
  AtFirehoseCursorManager,
} from './AtFirehoseCursorManager';

// Checkpoint store
export {
  RedisAtIngressCheckpointStore,
  InMemoryAtIngressCheckpointStore,
  CheckpointError,
} from './AtIngressCheckpointStore';
export type {
  AtIngressCheckpointStore,
} from './AtIngressCheckpointStore';

// Event classifier
export {
  Phase55AEventClassifier,
  Phase55BEventClassifier,
  InMemoryAtIngressEventClassifier,
  ClassifierError,
} from './AtIngressEventClassifier';
export type {
  AtIngressEventClassifier,
} from './AtIngressEventClassifier';

// Audit publisher
export {
  DefaultAtIngressAuditPublisher,
  InMemoryAtIngressAuditPublisher,
  AT_VERIFY_FAILED_TOPIC,
} from './AtIngressAuditPublisher';
export type {
  AtIngressAuditPublisher,
} from './AtIngressAuditPublisher';

// Verifier
export {
  DefaultAtIngressVerifier,
} from './AtIngressVerifier';

export type {
  AtIngressVerifier,
  AtCommitVerifier,
  AtIdentityResolver,
  AtSyncRebuilder,
} from './AtIngressVerifier';

// Webhook forwarder (memory UI integration)
export {
  AtIngressWebhookForwarder,
} from './AtIngressWebhookForwarder';
export type {
  WebhookEndpoint,
  ForwarderResult,
} from './AtIngressWebhookForwarder';
