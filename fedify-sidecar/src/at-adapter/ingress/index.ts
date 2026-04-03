/**
 * V6.5 Phase 5.5: AT Ingress Pipeline — Public API
 *
 * Barrel file exporting all public interfaces and implementations
 * for the external AT firehose intake pipeline.
 */

// Event schemas
export * from './AtIngressEvents.js';

// Consumer
export {
  DefaultAtFirehoseConsumer,
} from './AtFirehoseConsumer.js';
export type {
  AtFirehoseSource,
  AtFirehoseConsumer,
} from './AtFirehoseConsumer.js';

// Decoder
export {
  DefaultAtFirehoseDecoder,
  FirehoseDecodeError,
} from './AtFirehoseDecoder.js';
export type {
  DecodedFirehoseHeader,
  AtFirehoseDecoder,
} from './AtFirehoseDecoder.js';

// Cursor management
export {
  DefaultAtFirehoseCursorManager,
  InMemoryAtFirehoseCursorManager,
  CursorError,
} from './AtFirehoseCursorManager.js';
export type {
  AtFirehoseCursorManager,
} from './AtFirehoseCursorManager.js';

// Checkpoint store
export {
  RedisAtIngressCheckpointStore,
  InMemoryAtIngressCheckpointStore,
  CheckpointError,
} from './AtIngressCheckpointStore.js';
export type {
  AtIngressCheckpointStore,
} from './AtIngressCheckpointStore.js';

// Event classifier
export {
  Phase55AEventClassifier,
  Phase55BEventClassifier,
  InMemoryAtIngressEventClassifier,
  ClassifierError,
} from './AtIngressEventClassifier.js';
export type {
  AtIngressEventClassifier,
} from './AtIngressEventClassifier.js';

// Audit publisher
export {
  DefaultAtIngressAuditPublisher,
  InMemoryAtIngressAuditPublisher,
  AT_VERIFY_FAILED_TOPIC,
} from './AtIngressAuditPublisher.js';
export type {
  AtIngressAuditPublisher,
} from './AtIngressAuditPublisher.js';

// Verifier
export {
  DefaultAtIngressVerifier,
} from './AtIngressVerifier.js';

export type {
  AtIngressVerifier,
  AtCommitVerifier,
  AtIdentityResolver,
  AtSyncRebuilder,
} from './AtIngressVerifier.js';

export {
  AtIngressHttpClient,
  AtIngressHttpError,
} from './AtIngressHttpClient.js';
export {
  HttpAtIdentityResolver,
} from './HttpAtIdentityResolver.js';
export type {
  HttpAtIdentityResolverOptions,
  ResolvedAtIdentityDocument,
} from './HttpAtIdentityResolver.js';
export {
  HttpAtSyncRebuilder,
} from './HttpAtSyncRebuilder.js';
export type {
  HttpAtSyncRebuilderOptions,
} from './HttpAtSyncRebuilder.js';
export {
  buildAtExternalFirehoseBootstrap,
  parseAtExternalFirehoseSources,
} from './AtExternalFirehoseBootstrap.js';
export type {
  AtExternalFirehoseBootstrapOptions,
  AtExternalFirehoseBootstrapResult,
} from './AtExternalFirehoseBootstrap.js';

// Webhook forwarder (memory UI integration)
export {
  AtIngressWebhookForwarder,
} from './AtIngressWebhookForwarder.js';
export type {
  WebhookEndpoint,
  ForwarderResult,
} from './AtIngressWebhookForwarder.js';
