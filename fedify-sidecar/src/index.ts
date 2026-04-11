/**
 * Fedify Sidecar for ActivityPods - v5
 * 
 * Main entry point that initializes and starts all services:
 * - Redis Streams for work queues (inbound/outbound)
 * - RedPanda for event logs (Stream1, Stream2, Firehose)
 * - OpenSearch for activity storage and querying
 * - HTTP server for receiving inbound activities
 * - Workers for processing inbound/outbound activities
 * 
 * Key Architecture:
 * - Redis Streams: Work queues with consumer groups, XAUTOCLAIM for recovery
 * - RedPanda: Event logs only (NOT work queues)
 * - ActivityPods: Signing API (keys never leave), inbox forwarding
 */

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import {
  RedisStreamsQueue,
  createDefaultConfig as createQueueConfig,
  createInboundEnvelope,
  createOutboxIntent,
  createVerifiedInboundEnvelope,
} from "./queue/sidecar-redis-queue.js";
import { createSigningClient } from "./signing/signing-client.js";
import { createRedPandaProducer } from "./streams/redpanda-producer.js";
import { createSearchIndexerService, SearchIndexerService } from "./search/service/SearchIndexerService.js";
import {
  resolveTopicGovernanceOptionsFromEnv,
  verifyRedpandaTopics,
} from "./streams/redpanda-topic-governance.js";
import { createOutboundWorker, OutboundWorker } from "./delivery/outbound-worker.js";
import { createInboundWorker, InboundWorker } from "./delivery/inbound-worker.js";
import {
  createOutboxIntentWorker,
  OutboxIntentWorker,
} from "./delivery/outbox-intent-worker.js";
import { logger } from "./utils/logger.js";
import { registerAtXrpcRoutes, attachSubscribeReposWebSocket } from "./at-adapter/xrpc/AtXrpcFastifyBridge.js";
import { registerOAuthRoutes } from "./at-adapter/oauth/OAuthFastifyBridge.js";
import { OAuthParStore, OAuthAuthorizationCodeStore, OAuthRefreshTokenStore, OAuthGrantStore, OAuthDpopNonceStore, OAuthConsentChallengeStore, OAuthRateLimitStore } from "./at-adapter/oauth/OAuthRedisStores.js";
import { OAuthAsKeyManager } from "./at-adapter/oauth/OAuthAsKeyManager.js";
import { OAuthClientMetadataFetcher } from "./at-adapter/oauth/OAuthClientMetadataFetcher.js";
import { OAuthAuthorizationServer } from "./at-adapter/oauth/OAuthAuthorizationServer.js";
import { DpopVerifier } from "./at-adapter/oauth/DpopVerifier.js";
import type { OAuthAccessTokenVerifier } from "./at-adapter/oauth/OAuthTokenVerifier.js";
import { OAuthTokenVerifier } from "./at-adapter/oauth/OAuthTokenVerifier.js";
import { CompositeOAuthTokenVerifier } from "./at-adapter/oauth/CompositeOAuthTokenVerifier.js";
import { BackendIntrospectionTokenVerifier } from "./at-adapter/oauth/BackendIntrospectionTokenVerifier.js";
import { OAuthExternalDiscoveryBroker } from "./at-adapter/oauth/OAuthExternalDiscoveryBroker.js";
import { renderOAuthSecurityMetricsLines } from "./at-adapter/oauth/OAuthSecurityMetrics.js";
import {
  getMetrics as renderPrometheusMetrics,
  metrics as promMetrics,
} from "./metrics/index.js";
import { parseOAuthRouteRateLimitsFromEnv } from "./at-adapter/oauth/OAuthRateLimitConfig.js";
// AT adapter — identity
import { RedisIdentityBindingRepository } from "./core-domain/identity/RedisIdentityBindingRepository.js";
// AT adapter — repo / alias
import { RedisAtAliasStore } from "./at-adapter/repo/AtAliasStore.js";
import { RedisAtprotoRepoRegistry } from "./atproto/repo/AtprotoRepoRegistry.js";
import { DefaultAtRecordReader } from "./at-adapter/repo/AtRecordReader.js";
import { DefaultAtCarExporter } from "./at-adapter/repo/AtCarExporter.js";
import { DefaultAtRkeyService } from "./at-adapter/repo/AtRkeyService.js";
import { DefaultAtRecordRefResolver } from "./at-adapter/repo/AtRecordRefResolver.js";
import { DefaultAtTargetAliasResolver } from "./at-adapter/repo/AtTargetAliasResolver.js";
import { DefaultAtCommitBuilder } from "./at-adapter/repo/AtCommitBuilder.js";
import { DefaultAtCommitPersistenceService } from "./at-adapter/repo/AtCommitPersistenceService.js";
// AT adapter — identity / handle
import { DefaultHandleResolutionReader } from "./at-adapter/identity/HandleResolutionReader.js";
import { DefaultAtSubjectResolver } from "./at-adapter/identity/AtSubjectResolver.js";
import { HttpIdentityBindingSyncService } from "./at-adapter/identity/IdentityBindingSyncService.js";
import { IdentityWarmupService } from "./at-adapter/identity/IdentityWarmupService.js";
import { RedisIdentityWarmCursorStore } from "./at-adapter/identity/RedisIdentityWarmCursorStore.js";
// AT adapter — firehose
import { DefaultAtFirehoseSubscriptionManager } from "./at-adapter/firehose/AtFirehoseSubscriptionManager.js";
import { RedisAtFirehoseCursorStore } from "./at-adapter/firehose/AtFirehoseCursorStore.js";
import { DefaultAtFirehoseEventEncoder } from "./at-adapter/firehose/AtFirehoseEventEncoder.js";
import { DefaultAtFirehosePublisher } from "./at-adapter/firehose/AtFirehosePublisher.js";
import { AtFirehoseRuntime } from "./at-adapter/firehose/AtFirehoseRuntime.js";
import { DefaultAtRepoDiffBuilder } from "./at-adapter/repo/AtRepoDiffBuilder.js";
// AT adapter — auth / session
import { DefaultAtSessionTokenService } from "./at-adapter/auth/DefaultAtSessionTokenService.js";
import { DefaultAtAccountResolver } from "./at-adapter/auth/DefaultAtAccountResolver.js";
import { DefaultAtSessionService } from "./at-adapter/auth/DefaultAtSessionService.js";
import { RedisSessionFamilyStateStore } from "./at-adapter/auth/SessionFamilyStateStore.js";
import { createHttpAtPasswordVerifier } from "./at-adapter/auth/HttpAtPasswordVerifier.js";
import { LocalAtPasswordVerifier } from "./at-adapter/auth/LocalAtPasswordVerifier.js";
import { ExternalPdsClient } from "./at-adapter/external/ExternalPdsClient.js";
import { RedisExternalAtSessionStore } from "./at-adapter/external/ExternalAtSessionStore.js";
import { ExternalWriteGateway } from "./at-adapter/external/ExternalWriteGateway.js";
import { ExternalReadGateway } from "./at-adapter/external/ExternalReadGateway.js";
import { DefaultAtBlobStore } from "./at-adapter/blob/AtBlobStore.js";
import { DefaultBlobReferenceMapper } from "./at-adapter/blob/BlobReferenceMapper.js";
import { DefaultAtBlobUploadService } from "./at-adapter/blob/AtBlobUploadService.js";
// AT local fixture signing (dev/test only — activated by AT_LOCAL_FIXTURE=true)
import { LocalAtSigningService } from "./signing/LocalAtSigningService.js";
// AT adapter — projection
import { DefaultAtProjectionPolicy } from "./at-adapter/projection/AtProjectionPolicy.js";
import { DefaultAtProjectionWorker } from "./at-adapter/projection/AtProjectionWorker.js";
import { DefaultProfileRecordSerializer } from "./at-adapter/projection/serializers/ProfileRecordSerializer.js";
import { DefaultPostRecordSerializer } from "./at-adapter/projection/serializers/PostRecordSerializer.js";
import { DefaultStandardDocumentRecordSerializer } from "./at-adapter/projection/serializers/StandardDocumentRecordSerializer.js";
import { DefaultFacetBuilder } from "./at-adapter/projection/serializers/FacetBuilder.js";
import { DefaultEmbedBuilder } from "./at-adapter/projection/serializers/EmbedBuilder.js";
import { DefaultImageEmbedBuilder } from "./at-adapter/projection/serializers/ImageEmbedBuilder.js";
import { StoredAttachmentMediaResolver } from "./at-adapter/projection/serializers/StoredAttachmentMediaResolver.js";
import { DefaultVideoEmbedBuilder } from "./at-adapter/projection/serializers/VideoEmbedBuilder.js";
import { DefaultFollowRecordSerializer } from "./at-adapter/projection/serializers/FollowRecordSerializer.js";
import { DefaultLikeRecordSerializer } from "./at-adapter/projection/serializers/LikeRecordSerializer.js";
import { DefaultRepostRecordSerializer } from "./at-adapter/projection/serializers/RepostRecordSerializer.js";
// AT adapter — writes
import { DefaultAtWriteNormalizer } from "./at-adapter/writes/DefaultAtWriteNormalizer.js";
import { DefaultAtWritePolicyGate } from "./at-adapter/writes/DefaultAtWritePolicyGate.js";
import { DefaultAtWriteGateway } from "./at-adapter/writes/DefaultAtWriteGateway.js";
import { DefaultCanonicalClientWriteService } from "./at-adapter/writes/DefaultCanonicalClientWriteService.js";
import { RedisAtWriteResultStore } from "./at-adapter/writes/AtWriteResultStore.js";
import type { AtWriteResultStore } from "./at-adapter/writes/AtWriteResultStore.js";
// Signing + event contracts
import type { SigningService } from "./core-domain/contracts/SigningContracts.js";
import type { EventPublisher } from "./core-domain/events/CoreIdentityEvents.js";
import { RedpandaEventPublisher } from "./core-domain/events/RedpandaEventPublisher.js";
import { RedisProjectionLedger } from "./protocol-bridge/idempotency/ProjectionLedger.js";
import { ActivityPubToCanonicalTranslator } from "./protocol-bridge/activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "./protocol-bridge/atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "./protocol-bridge/projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "./protocol-bridge/projectors/CanonicalToAtprotoProjector.js";
import { AtprotoWriteGatewayPort } from "./protocol-bridge/adapters/AtprotoWriteGatewayPort.js";
import { EventPublisherActivityPubPort } from "./protocol-bridge/adapters/EventPublisherActivityPubPort.js";
import { ActivityPubBridgeIngressClient } from "./protocol-bridge/runtime/ActivityPubBridgeIngressClient.js";
import { ActivityPubBridgeOutboundResolverClient } from "./protocol-bridge/runtime/ActivityPubBridgeOutboundResolverClient.js";
import { ActivityPubBridgeActivityResolverClient } from "./protocol-bridge/runtime/ActivityPubBridgeActivityResolverClient.js";
import { ActivityPubBridgeMediaClient } from "./protocol-bridge/runtime/ActivityPubBridgeMediaClient.js";
import { ActivityPubBridgeProfileMediaClient } from "./protocol-bridge/runtime/ActivityPubBridgeProfileMediaClient.js";
import { AtprotoAttachmentMediaResolver } from "./protocol-bridge/runtime/AtprotoAttachmentMediaResolver.js";
import { AtprotoProfileMediaResolver } from "./protocol-bridge/runtime/AtprotoProfileMediaResolver.js";
import { AtprotoLinkPreviewThumbResolver } from "./protocol-bridge/runtime/AtprotoLinkPreviewThumbResolver.js";
import { AtIngressRuntime } from "./at-adapter/ingress/AtIngressRuntime.js";
import { buildAtExternalFirehoseBootstrap, parseAtExternalFirehoseSources } from "./at-adapter/ingress/AtExternalFirehoseBootstrap.js";
import { HttpAtIdentityResolver } from "./at-adapter/ingress/HttpAtIdentityResolver.js";
import { ProductionAtCommitVerifier } from "./at-adapter/ingress/ProductionAtCommitVerifier.js";
import { normalizeActivityPubNoteLinkPreviewMode } from "./protocol-bridge/projectors/activitypub/ActivityPubProjectionPolicy.js";
import {
  normalizeActivityPubDomainRuleList,
} from "./protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";
import { ProtocolBridgeRuntime } from "./protocol-bridge/runtime/ProtocolBridgeRuntime.js";
import { createProtocolBridgeContexts } from "./protocol-bridge/runtime/createProtocolBridgeContexts.js";
import { RedisBridgeProfileMediaStore } from "./protocol-bridge/profile/BridgeProfileMedia.js";
import { RedisBridgePostMediaStore } from "./protocol-bridge/post/BridgePostMedia.js";
import { ApToAtProjectionWorker } from "./protocol-bridge/workers/ApToAtProjectionWorker.js";
import { AtToApProjectionWorker } from "./protocol-bridge/workers/AtToApProjectionWorker.js";
import { CanonicalIntentPublisher, CANONICAL_V1_TOPIC } from "./protocol-bridge/canonical/CanonicalIntentPublisher.js";
import { CanonicalNotificationConsumer } from "./protocol-bridge/notifications/CanonicalNotificationConsumer.js";
// Fedify runtime integration (feature-flagged: ENABLE_FEDIFY_RUNTIME_INTEGRATION=true)
import { FedifyKvAdapter } from "./federation/FedifyKvAdapter.js";
import { createFedifyAdapter, type FedifyFederationAdapter } from "./federation/FedifyFederationAdapter.js";
import { registerFedifyRoutes } from "./federation/FedifyFastifyBridge.js";
import {
  evaluateOutboundWebhookBackpressure,
  normalizeAndDedupeOutboundTargets,
  OutboundWebhookValidationError,
  resolveOutboundWebhookBackpressureConfigFromEnv,
} from "./delivery/outbound-webhook.js";
import { registerMrfAdminIntegration } from "./admin/mrf/integration.js";
import { registerModerationBridgeIntegration } from "./admin/moderation/integration.js";
import {
  ApRelaySubscriptionService,
  parseRelayActorUrls,
} from "./federation/relay/ApRelaySubscriptionService.js";
import {
  AtJetstreamService,
  parseJetstreamUrl,
} from "./at-adapter/jetstream/AtJetstreamService.js";

function normalizeMrfAdminStoreMode(raw: string | undefined): "memory" | "redis" {
  return raw === "redis" ? "redis" : "memory";
}

type StartupMode = "blocking" | "background";
type StartupPhase = "starting" | "ready" | "failed";

interface StartupTask {
  name: string;
  start(): Promise<void>;
}

interface StartupState {
  mode: StartupMode;
  phase: StartupPhase;
  startedAtMs: number;
  readyAtMs: number | null;
  currentStep: string | null;
  completedSteps: string[];
  failedStep: string | null;
  error: string | null;
}

function resolveStartupMode(raw: string | undefined, nodeEnv: string): StartupMode {
  if (raw === "blocking" || raw === "background") {
    return raw;
  }

  return nodeEnv === "production" ? "blocking" : "background";
}

// ============================================================================
// Configuration
// ============================================================================

const config = {
  version: process.env["VERSION"] || "5.0.0",
  nodeEnv: process.env["NODE_ENV"] || "development",
  startupMode: resolveStartupMode(
    process.env["SIDECAR_STARTUP_MODE"],
    process.env["NODE_ENV"] || "development",
  ),
  port: parseInt(process.env["PORT"] || "8080", 10),
  host: process.env["HOST"] || "0.0.0.0",
  domain: process.env["DOMAIN"] || "localhost",
  sidecarToken: process.env["SIDECAR_TOKEN"] || "",
  
  // Feature flags
  enableOutboundWorker: process.env["ENABLE_OUTBOUND_WORKER"] !== "false",
  enableInboundWorker: process.env["ENABLE_INBOUND_WORKER"] !== "false",
  enableOutboxIntentWorker: process.env["ENABLE_OUTBOX_INTENT_WORKER"] !== "false",
  enableOpenSearchIndexer: process.env["ENABLE_OPENSEARCH_INDEXER"] !== "false",
  enableXrpcServer: process.env["ENABLE_XRPC_SERVER"] !== "false",
  enableFedifyRuntimeIntegration:
    process.env["ENABLE_FEDIFY_RUNTIME_INTEGRATION"] === "true",
  enableProtocolBridgeApToAt: process.env["ENABLE_PROTOCOL_BRIDGE_AP_TO_AT"] === "true",
  // AT→AP is auto-enabled when Jetstream is on, so Bluesky content reaches the AP timeline.
  // Can be explicitly set to "false" to disable even when ENABLE_AT_JETSTREAM=true.
  enableProtocolBridgeAtToAp:
    process.env["ENABLE_PROTOCOL_BRIDGE_AT_TO_AP"] === "true" ||
    (process.env["ENABLE_AT_JETSTREAM"] === "true" &&
      process.env["ENABLE_PROTOCOL_BRIDGE_AT_TO_AP"] !== "false"),
  enableMrfAdminApi: process.env["ENABLE_MRF_ADMIN_API"] === "true",
  mrfAdminToken: process.env["MRF_ADMIN_TOKEN"] || "",
  mrfAdminStore: normalizeMrfAdminStoreMode(process.env["MRF_ADMIN_STORE"]),
  mrfAdminRedisPrefix: process.env["MRF_ADMIN_REDIS_PREFIX"] || "mrf:admin",
  enableModerationBridgeApi:
    process.env["ENABLE_MODERATION_BRIDGE_API"] === "true" ||
    process.env["ENABLE_MRF_ADMIN_API"] === "true",
  moderationBridgeRedisPrefix:
    process.env["MODERATION_BRIDGE_REDIS_PREFIX"] || "moderation:bridge",
  moderationLabelerDid:
    process.env["MODERATION_LABELER_DID"] || `did:web:${process.env["DOMAIN"] || "localhost"}`,
  moderationLabelerSigningKeyHex: process.env["MODERATION_LABELER_SIGNING_KEY_HEX"] || "",
  moderationAtAdminXrpcBaseUrl: process.env["MODERATION_AT_ADMIN_XRPC_BASE_URL"] || "",
  moderationAtAdminBearerToken: process.env["MODERATION_AT_ADMIN_BEARER_TOKEN"] || "",
  moderationAtAdminTimeoutMs: Number.parseInt(
    process.env["MODERATION_AT_ADMIN_TIMEOUT_MS"] || "5000",
    10,
  ),

  // AP relay subscription
  // AP_RELAY_ACTOR_URLS: comma-separated list of relay actor URLs to follow.
  // Each URL must use https and follow the ActivityRelay / LitePub relay
  // protocol (actor document served at the URL, inbox URL embedded within).
  //
  // Common relay actor URL formats:
  //   https://relay.example.com/actor       (ActivityRelay standard)
  //   https://mastodon.social/relay          (Mastodon built-in relay)
  //
  // Pre-configured relay targets (set AP_RELAY_ACTOR_URLS to override):
  //   https://mastodon.social/relay
  //   https://mastodon.online/relay
  //   https://flipboard.social/relay
  //   https://cosocial.ca/relay
  //   https://web.brid.gy/relay
  //   https://sigmoid.social/relay
  //   https://twit.social/relay
  //   https://blacktwitter.io/relay
  //   https://social.coop/relay
  //   https://mstdn.games/relay
  //   https://werd.social/relay
  //   https://Beige.party/relay
  //   https://glammr.us/relay
  //   https://dmv.community/relay
  //   https://mastodon.mit.edu/relay
  //   https://c.im/relay
  //   https://channel.org/relay
  //   https://dair-community.social/relay
  //   https://macaw.social/relay
  //   https://ursal.zone/relay
  //   https://geekdom.social/relay
  //   https://blorbo.social/relay
  //   https://sunny.garden/relay
  apRelayActorUrls: parseRelayActorUrls(
    process.env["AP_RELAY_ACTOR_URLS"] ??
    [
      "https://relay.fedi.buzz/instance/mastodon.social",
      "https://relay.fedi.buzz/instance/mastodon.online",
      "https://relay.fedi.buzz/instance/flipboard.social",
      "https://relay.fedi.buzz/instance/cosocial.ca",
      "https://relay.fedi.buzz/instance/web.brid.gy",
      "https://relay.fedi.buzz/instance/sigmoid.social",
      "https://relay.fedi.buzz/instance/twit.social",
      "https://relay.fedi.buzz/instance/blacktwitter.io",
      "https://relay.fedi.buzz/instance/social.coop",
      "https://relay.fedi.buzz/instance/mstdn.games",
      "https://relay.fedi.buzz/instance/werd.social",
      "https://relay.fedi.buzz/instance/Beige.party",
      "https://relay.fedi.buzz/instance/glammr.us",
      "https://relay.fedi.buzz/instance/dmv.community",
      "https://relay.fedi.buzz/instance/mastodon.mit.edu",
      "https://relay.fedi.buzz/instance/c.im",
      "https://relay.fedi.buzz/instance/channel.org",
      "https://relay.fedi.buzz/instance/dair-community.social",
      "https://relay.fedi.buzz/instance/macaw.social",
      "https://relay.fedi.buzz/instance/ursal.zone",
      "https://relay.fedi.buzz/instance/geekdom.social",
      "https://relay.fedi.buzz/instance/blorbo.social",
      "https://relay.fedi.buzz/instance/sunny.garden",
    ].join(",")
  ),
  // AP_RELAY_LOCAL_ACTOR_URI: the local AP actor that sends Follow activities
  // to relay servers.  Must be an actor whose private key is held by
  // ActivityPods.  Defaults to https://${DOMAIN}/users/relay.
  apRelayLocalActorUri: process.env["AP_RELAY_LOCAL_ACTOR_URI"] || "",
  // How often (ms) to re-check relay subscriptions. Default: 24 h.
  apRelayResubscribeIntervalMs: Number.parseInt(
    process.env["AP_RELAY_RESUBSCRIBE_INTERVAL_MS"] || `${24 * 60 * 60 * 1_000}`,
    10,
  ),

  // Canonical event log (canonical.v1) — durable protocol-neutral record of
  // every translated CanonicalIntent from both AT and AP bridge workers.
  // ENABLE_CANONICAL_EVENT_LOG=true activates publishing from projection workers.
  // ENABLE_CANONICAL_NOTIFICATIONS=true activates the in-app notification consumer.
  // CANONICAL_TOPIC overrides the default topic name (canonical.v1).
  enableCanonicalEventLog:
    process.env["ENABLE_CANONICAL_EVENT_LOG"] !== "false" &&
    (process.env["ENABLE_PROTOCOL_BRIDGE_AP_TO_AT"] === "true" ||
      process.env["ENABLE_PROTOCOL_BRIDGE_AT_TO_AP"] === "true" ||
      process.env["ENABLE_AT_JETSTREAM"] === "true"),
  enableCanonicalNotifications:
    process.env["ENABLE_CANONICAL_NOTIFICATIONS"] !== "false" &&
    (process.env["ENABLE_PROTOCOL_BRIDGE_AP_TO_AT"] === "true" ||
      process.env["ENABLE_PROTOCOL_BRIDGE_AT_TO_AP"] === "true" ||
      process.env["ENABLE_AT_JETSTREAM"] === "true"),
  canonicalTopic: process.env["CANONICAL_TOPIC"] || CANONICAL_V1_TOPIC,

  // ATProto Jetstream (lightweight JSON firehose from Bluesky infrastructure).
  // ENABLE_AT_JETSTREAM=true activates ingestion.
  // JETSTREAM_URL overrides the default endpoint (wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post).
  // JETSTREAM_MAX_EVENTS: if set, service exits cleanly after N published events (useful for smoke tests).
  enableAtJetstream: process.env["ENABLE_AT_JETSTREAM"] === "true",
  atJetstreamUrl: parseJetstreamUrl(process.env["JETSTREAM_URL"]),
  atJetstreamPublishTopic:
    process.env["AT_JETSTREAM_PUBLISH_TOPIC"] ||
    process.env["PROTOCOL_BRIDGE_AT_VERIFIED_INGRESS_TOPIC"] ||
    "at.ingress.v1",
  atJetstreamMaxEvents: process.env["JETSTREAM_MAX_EVENTS"]
    ? Number.parseInt(process.env["JETSTREAM_MAX_EVENTS"], 10)
    : undefined,

  // Phase 7: AT session token secret (min 32 chars).
  // Required when ENABLE_XRPC_SERVER is true.
  atSessionSecret: process.env["AT_SESSION_SECRET"] || "",

  // Phase 7: PDS hostname advertised in server.describeServer
  atPdsHostname: process.env["AT_PDS_HOSTNAME"] || process.env["DOMAIN"] || "localhost",

  // ATProto OAuth settings
  enableAtprotoOauth: process.env["ENABLE_ATPROTO_OAUTH"] !== "false",
  atOauthIssuer: process.env["AT_OAUTH_ISSUER"] || "http://localhost:8080",
  atOauthAuthorizationServerOrigin:
    process.env["AT_OAUTH_AUTHORIZATION_SERVER_ORIGIN"] || "http://localhost:8080",
  atOauthResourceServerOrigin:
    process.env["AT_OAUTH_RESOURCE_SERVER_ORIGIN"] || "http://localhost:8080",
  atOauthClientMetadataTimeoutMs: Number.parseInt(
    process.env["AT_OAUTH_CLIENT_METADATA_TIMEOUT_MS"] || "6000",
    10
  ),
  atOauthClientMetadataMaxAttempts: Number.parseInt(
    process.env["AT_OAUTH_CLIENT_METADATA_MAX_ATTEMPTS"] || "4",
    10
  ),
  atOauthExternalDiscoveryTimeoutMs: Number.parseInt(
    process.env["AT_OAUTH_EXTERNAL_DISCOVERY_TIMEOUT_MS"] || "6000",
    10
  ),
  atOauthExternalDiscoveryMaxAttempts: Number.parseInt(
    process.env["AT_OAUTH_EXTERNAL_DISCOVERY_MAX_ATTEMPTS"] || "4",
    10
  ),
  atOauthAllowLocalhostHttpDiscovery: process.env["AT_OAUTH_ALLOW_LOCALHOST_HTTP_DISCOVERY"] === "true",
  atOauthBackendIntrospectionTimeoutMs: Number.parseInt(
    process.env["AT_OAUTH_BACKEND_INTROSPECTION_TIMEOUT_MS"] || "3000",
    10
  ),
  atOauthBackendIntrospectionMaxAttempts: Number.parseInt(
    process.env["AT_OAUTH_BACKEND_INTROSPECTION_MAX_ATTEMPTS"] || "3",
    10
  ),

  // Phase 7: durable write-result correlation settings
  atWriteResultTtlSec: Number.parseInt(process.env["AT_WRITE_RESULT_TTL_SEC"] || "120", 10),
  atWriteResultKeyPrefix: process.env["AT_WRITE_RESULT_KEY_PREFIX"] || "at:write-result",
  atWriteResultChannelPrefix: process.env["AT_WRITE_RESULT_CHANNEL_PREFIX"] || "at:write-result:ch",

  // Local fixture mode — for development / integration testing ONLY.
  // When true: uses LocalAtPasswordVerifier (no ActivityPods auth call) and
  // LocalAtSigningService (secp256k1 signing from Redis-stored fixture keys).
  // NEVER set in production.  Requires provision-test-fixture.ts to have been run.
  atLocalFixture: process.env["AT_LOCAL_FIXTURE"] === "true",

  identityWarmIntervalMs: Number.parseInt(process.env["IDENTITY_WARM_INTERVAL_MS"] || "30000", 10),
  identityWarmBatchLimit: Number.parseInt(process.env["IDENTITY_WARM_BATCH_LIMIT"] || "100", 10),
  externalAtSessionTtlSeconds: Number.parseInt(
    process.env["EXTERNAL_AT_SESSION_TTL_SECONDS"] || `${60 * 60 * 12}`,
    10
  ),
  externalPdsTimeoutMs: Number.parseInt(process.env["EXTERNAL_PDS_TIMEOUT_MS"] || "8000", 10),
  externalPdsMaxAttempts: Number.parseInt(process.env["EXTERNAL_PDS_MAX_ATTEMPTS"] || "5", 10),
  atOauthRouteRateLimits: parseOAuthRouteRateLimitsFromEnv(process.env),
  protocolBridgeConsumerGroupId:
    process.env["PROTOCOL_BRIDGE_CONSUMER_GROUP_ID"] || "fedify-sidecar-protocol-bridge",
  protocolBridgeApSourceTopic:
    process.env["PROTOCOL_BRIDGE_AP_SOURCE_TOPIC"] ||
    process.env["STREAM1_TOPIC"] ||
    "ap.stream1.local-public.v1",
  protocolBridgeAtCommitTopic:
    process.env["PROTOCOL_BRIDGE_AT_COMMIT_TOPIC"] || "at.commit.v1",
  protocolBridgeAtVerifiedIngressTopic:
    process.env["PROTOCOL_BRIDGE_AT_VERIFIED_INGRESS_TOPIC"] || "at.ingress.v1",
  protocolBridgeApIngressTopic:
    process.env["PROTOCOL_BRIDGE_AP_INGRESS_TOPIC"] || "ap.atproto-ingress.v1",
  atFirehoseConsumerGroupId:
    process.env["AT_FIREHOSE_CONSUMER_GROUP_ID"] || "fedify-sidecar-at-firehose",
  atFirehoseCursorMaxEvents: Number.parseInt(
    process.env["AT_FIREHOSE_CURSOR_MAX_EVENTS"] || "10000",
    10,
  ),
  atExternalFirehoseConsumerGroupId:
    process.env["AT_EXTERNAL_FIREHOSE_CONSUMER_GROUP_ID"] || "fedify-sidecar-at-firehose-external",
  atExternalFirehoseRawTopic:
    process.env["AT_EXTERNAL_FIREHOSE_RAW_TOPIC"] || "at.firehose.raw.v1",
  enableAtExternalFirehose: process.env["ENABLE_AT_EXTERNAL_FIREHOSE"] === "true",
  protocolBridgeLedgerTtlSec: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_LEDGER_TTL_SEC"] || `${60 * 60 * 24 * 14}`,
    10,
  ),
  protocolBridgeIngressTimeoutMs: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_INGRESS_TIMEOUT_MS"] || "10000",
    10,
  ),
  protocolBridgeOutboundResolutionTimeoutMs: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_OUTBOUND_RESOLUTION_TIMEOUT_MS"] || "10000",
    10,
  ),
  protocolBridgeActivityResolutionTimeoutMs: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_ACTIVITY_RESOLUTION_TIMEOUT_MS"] || "10000",
    10,
  ),
  protocolBridgeProfileMediaTimeoutMs: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_PROFILE_MEDIA_TIMEOUT_MS"] || "10000",
    10,
  ),
  protocolBridgeProfileMediaMaxBytes: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_PROFILE_MEDIA_MAX_BYTES"] || `${5 * 1024 * 1024}`,
    10,
  ),
  protocolBridgeAttachmentMediaTimeoutMs: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_ATTACHMENT_MEDIA_TIMEOUT_MS"] || "20000",
    10,
  ),
  protocolBridgeAttachmentMediaMaxBytes: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_ATTACHMENT_MEDIA_MAX_BYTES"] || `${50 * 1024 * 1024}`,
    10,
  ),
  protocolBridgeProfileMediaTtlSec: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_PROFILE_MEDIA_TTL_SEC"] || `${60 * 60 * 24}`,
    10,
  ),
  protocolBridgePostMediaTtlSec: Number.parseInt(
    process.env["PROTOCOL_BRIDGE_POST_MEDIA_TTL_SEC"] || `${60 * 60 * 24}`,
    10,
  ),
  protocolBridgeApNoteLinkPreviewMode: normalizeActivityPubNoteLinkPreviewMode(
    process.env["PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_MODE"],
  ),
  protocolBridgeApNoteLinkPreviewRichDomains: normalizeActivityPubDomainRuleList(
    process.env["PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_RICH_DOMAINS"],
  ),
  protocolBridgeApNoteLinkPreviewDisabledDomains: normalizeActivityPubDomainRuleList(
    process.env["PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_DISABLED_DOMAINS"],
  ),
};

const outboundWebhookBackpressureConfig = resolveOutboundWebhookBackpressureConfigFromEnv();

// ============================================================================
// Global State
// ============================================================================
let queue: RedisStreamsQueue | null = null;
let outboundWorker: OutboundWorker | null = null;
let inboundWorker: InboundWorker | null = null;
let outboxIntentWorker: OutboxIntentWorker | null = null;
let opensearchIndexer: SearchIndexerService | null = null;
let atRedisClient: Redis | null = null;
let writeResultStore: AtWriteResultStore | null = null;
let identityWarmupService: IdentityWarmupService | null = null;
let atEventPublisher: RedpandaEventPublisher | null = null;
let atFirehoseRuntime: AtFirehoseRuntime | null = null;
let atExternalFirehoseRuntime: AtIngressRuntime | null = null;
let protocolBridgeRuntime: ProtocolBridgeRuntime | null = null;
let searchIndexerRedis: Redis | null = null;
let mrfAdminRedisClient: Redis | null = null;
let moderationBridgeRedisClient: Redis | null = null;
let fedifyAdapter: FedifyFederationAdapter | null = null;
let apRelaySubscriptionService: ApRelaySubscriptionService | null = null;
let atJetstreamService: AtJetstreamService | null = null;
let isShuttingDown = false;
const startupState: StartupState = {
  mode: config.startupMode,
  phase: "starting",
  startedAtMs: Date.now(),
  readyAtMs: null,
  currentStep: null,
  completedSteps: [],
  failedStep: null,
  error: null,
};

function completeStartupTask(taskName: string): void {
  if (!startupState.completedSteps.includes(taskName)) {
    startupState.completedSteps.push(taskName);
  }
  startupState.currentStep = null;
}

function snapshotStartupState() {
  const now = Date.now();

  return {
    mode: startupState.mode,
    phase: startupState.phase,
    currentStep: startupState.currentStep,
    completedSteps: [...startupState.completedSteps],
    failedStep: startupState.failedStep,
    error: startupState.error,
    durationMs: (startupState.readyAtMs ?? now) - startupState.startedAtMs,
    startedAt: new Date(startupState.startedAtMs).toISOString(),
    readyAt: startupState.readyAtMs ? new Date(startupState.readyAtMs).toISOString() : null,
  };
}

async function runStartupTasks(tasks: StartupTask[]): Promise<void> {
  for (const task of tasks) {
    startupState.currentStep = task.name;
    logger.info("Startup task started", {
      task: task.name,
      mode: startupState.mode,
    });

    try {
      await task.start();
      completeStartupTask(task.name);
      logger.info("Startup task completed", { task: task.name });
    } catch (error: any) {
      startupState.phase = "failed";
      startupState.failedStep = task.name;
      startupState.error = error?.message || String(error);
      throw error;
    }
  }
}

function markStartupReady(): void {
  startupState.phase = "ready";
  startupState.readyAtMs = Date.now();
  startupState.currentStep = null;
  startupState.failedStep = null;
  startupState.error = null;
}

// ============================================================================
// Main Application
// ============================================================================

async function main() {
  logger.info("Starting Fedify Sidecar for ActivityPods", {
    version: config.version,
    nodeEnv: config.nodeEnv,
    startupMode: config.startupMode,
  });

  const activityPubOutboundDeliveryPolicy = {
    defaultNoteLinkPreviewMode: config.protocolBridgeApNoteLinkPreviewMode,
    richNoteLinkPreviewDomains: config.protocolBridgeApNoteLinkPreviewRichDomains,
    disabledNoteLinkPreviewDomains: config.protocolBridgeApNoteLinkPreviewDisabledDomains,
  } as const;

  const redpandaProducerRequired =
    config.enableOutboxIntentWorker
    || config.enableOutboundWorker
    || config.enableInboundWorker;
  const kafkaBackplaneRequired =
    redpandaProducerRequired
    || config.enableOpenSearchIndexer
    || config.enableXrpcServer
    || config.enableProtocolBridgeApToAt
    || config.enableProtocolBridgeAtToAp
    || config.enableAtJetstream
    || config.enableAtExternalFirehose
    || config.enableCanonicalEventLog
    || config.enableCanonicalNotifications;
  const startupTasks: StartupTask[] = [];

  const enforceTopicGovernance = process.env["REDPANDA_ENFORCE_TOPIC_GOVERNANCE"] !== "false";

  if (config.enableXrpcServer && !config.atLocalFixture) {
    if (!process.env["ACTIVITYPODS_URL"]) {
      throw new Error("ENABLE_XRPC_SERVER requires ACTIVITYPODS_URL when AT_LOCAL_FIXTURE is false");
    }
    if (!process.env["ACTIVITYPODS_TOKEN"]) {
      throw new Error("ENABLE_XRPC_SERVER requires ACTIVITYPODS_TOKEN when AT_LOCAL_FIXTURE is false");
    }
    if (!process.env["EXTERNAL_AT_SESSION_KEY_HEX"]) {
      throw new Error("ENABLE_XRPC_SERVER requires EXTERNAL_AT_SESSION_KEY_HEX when AT_LOCAL_FIXTURE is false");
    }
  }

  // Fixture mode banner — unmistakable, fires before any service connections
  if (config.atLocalFixture) {
    let fixtureAccountIds: string[] = [];
    try {
      const raw = process.env['AT_LOCAL_FIXTURE_CREDS'];
      const creds = raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : { 'http://localhost:3000/atproto365133': '(default)' };
      fixtureAccountIds = Object.keys(creds);
    } catch {
      fixtureAccountIds = ['(parse error — using defaults)'];
    }
    const accountList = fixtureAccountIds.map((id) => `    • ${id}`).join('\n');
    process.stderr.write(
      `\n${'='.repeat(72)}\n` +
      `  WARNING: AT_LOCAL_FIXTURE=true — LOCAL FIXTURE MODE ENABLED\n` +
      `  LocalAtPasswordVerifier + LocalAtSigningService are ACTIVE.\n` +
      `  ActivityPods auth and signing endpoints are BYPASSED.\n` +
      `  NEVER deploy with this flag set.\n` +
      `  Fixture accounts (${fixtureAccountIds.length}):\n` +
      accountList + '\n' +
      `${'='.repeat(72)}\n\n`,
    );
  }

  // Register shutdown handlers
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error: error.message, stack: error.stack });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { reason });
    shutdown("unhandledRejection");
  });

  try {
    if (kafkaBackplaneRequired && enforceTopicGovernance) {
      const topicGovernanceOptions = resolveTopicGovernanceOptionsFromEnv();
      startupTasks.push({
        name: "verify Redpanda topic governance",
        start: async () => {
          await verifyRedpandaTopics(topicGovernanceOptions);
          logger.info("Redpanda topic governance verification passed", {
            profile: topicGovernanceOptions.profile,
            brokers: topicGovernanceOptions.brokers,
          });
        },
      });
    }

    // Initialize Redis Streams queue
    const queueConfig = createQueueConfig();
    queue = new RedisStreamsQueue(queueConfig);
    await queue.connect();
    logger.info("Redis Streams queue connected");

    // Initialize Signing client
    const signingClient = createSigningClient();
    logger.info("Signing client initialized");

    // Initialize RedPanda producer only when worker/indexer features need it.
    let redpanda: any = null;
    if (redpandaProducerRequired) {
      redpanda = createRedPandaProducer();
      startupTasks.push({
        name: "connect RedPanda producer",
        start: async () => {
          await redpanda.connect();
          logger.info("RedPanda producer connected");
        },
      });
    } else {
      logger.info("RedPanda producer skipped (worker delivery pipeline disabled)");
    }

    // Initialize Fedify 2.x runtime adapter (feature-flagged)
    if (config.enableFedifyRuntimeIntegration) {
      const fedifyRedis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
      fedifyRedis.on("error", (err: Error) =>
        logger.error("Fedify KV Redis error", { error: err.message }),
      );
      const kv = new FedifyKvAdapter(fedifyRedis);
      fedifyAdapter = createFedifyAdapter(
        kv,
        {
          domain: config.domain,
          activityPodsUrl: process.env["ACTIVITYPODS_URL"] ?? "http://localhost:3000",
          activityPodsToken: process.env["ACTIVITYPODS_TOKEN"] ?? "",
          requestTimeoutMs: Number.parseInt(process.env["REQUEST_TIMEOUT_MS"] || "30000", 10),
          userAgent: process.env["USER_AGENT"] || "Fedify-Sidecar/1.0 (ActivityPods)",
          enqueueVerifiedInbox: async (delivery) => {
            if (!queue) {
              throw new Error("Redis queue not initialized");
            }

            const envelope = createVerifiedInboundEnvelope({
              path: delivery.path,
              body: delivery.body,
              remoteIp: delivery.remoteIp,
              verifiedActorUri: delivery.verifiedActorUri,
              verifiedAt: delivery.verifiedAt,
            });
            await queue.enqueueInbound(envelope);
            return { envelopeId: envelope.envelopeId };
          },
        },
        logger,
      );
      logger.info("Fedify runtime adapter initialized", { domain: config.domain });
    }

    // Initialize AP relay subscription service (requires Fedify + outbox intent worker)
    if (
      config.enableFedifyRuntimeIntegration &&
      config.enableOutboxIntentWorker &&
      config.apRelayActorUrls.length > 0
    ) {
      const relayLocalActorUri =
        config.apRelayLocalActorUri || `https://${config.domain}/users/relay`;
      const relayRedis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
      relayRedis.on("error", (err: Error) =>
        logger.error("Relay subscription Redis error", { error: err.message }),
      );
      apRelaySubscriptionService = new ApRelaySubscriptionService(
        relayRedis,
        queue!,
        {
          relayActorUrls: config.apRelayActorUrls,
          localActorUri: relayLocalActorUri,
          domain: config.domain,
          resubscribeIntervalMs: config.apRelayResubscribeIntervalMs,
          userAgent: process.env["USER_AGENT"] || "Fedify-Sidecar/1.0 (ActivityPods)",
        },
        logger,
      );
      startupTasks.push({
        name: "start AP relay subscription service",
        start: async () => {
          await apRelaySubscriptionService!.start();
          logger.info("AP relay subscription service started", {
            relays: config.apRelayActorUrls,
            localActorUri: relayLocalActorUri,
          });
        },
      });
    } else if (config.apRelayActorUrls.length > 0 && !config.enableFedifyRuntimeIntegration) {
      logger.warn(
        "AP_RELAY_ACTOR_URLS configured but ENABLE_FEDIFY_RUNTIME_INTEGRATION is false — relay subscription disabled",
      );
    }

    // Initialize OpenSearch indexer (dedicated search indexer service)
    if (config.enableOpenSearchIndexer) {
      searchIndexerRedis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
      searchIndexerRedis.on("error", (err: Error) =>
        logger.error("Search indexer Redis client error", { error: err.message }),
      );
      opensearchIndexer = createSearchIndexerService({
        redis: searchIndexerRedis as any,
      });
      startupTasks.push({
        name: "start OpenSearch indexer",
        start: async () => {
          await opensearchIndexer!.initialize();
          opensearchIndexer!.start().catch(err => {
            logger.error("OpenSearch indexer error", { error: err.message });
          });
          logger.info("OpenSearch indexer started");
        },
      });
    }

    // Initialize outbound worker
    if (config.enableOutboundWorker) {
      outboundWorker = createOutboundWorker(queue, signingClient, redpanda, {
        fedifyRuntimeIntegrationEnabled: config.enableFedifyRuntimeIntegration,
        ...(fedifyAdapter ? { adapter: fedifyAdapter } : {}),
      });
      startupTasks.push({
        name: "start outbound worker",
        start: async () => {
          outboundWorker!.start().catch(err => {
            logger.error("Outbound worker error", { error: err.message });
          });
          logger.info("Outbound worker started");
        },
      });
    }

    if (config.enableOutboxIntentWorker) {
      outboxIntentWorker = createOutboxIntentWorker(queue, redpanda, {
        activityPubOutboundDeliveryPolicy,
      });
      startupTasks.push({
        name: "start outbox intent worker",
        start: async () => {
          outboxIntentWorker!.start().catch((err) => {
            logger.error("Outbox intent worker error", { error: err.message });
          });
          logger.info("Outbox intent worker started");
        },
      });
    }

    // Initialize inbound worker
    if (config.enableInboundWorker) {
      inboundWorker = createInboundWorker(queue, redpanda, {
        fedifyRuntimeIntegrationEnabled: config.enableFedifyRuntimeIntegration,
        ...(fedifyAdapter ? { adapter: fedifyAdapter } : {}),
      });
      startupTasks.push({
        name: "start inbound worker",
        start: async () => {
          inboundWorker!.start().catch(err => {
            logger.error("Inbound worker error", { error: err.message });
          });
          logger.info("Inbound worker started");
        },
      });
    }

    // Create HTTP server
    const app = Fastify({
      logger: false,
      trustProxy: true,
      bodyLimit: 1024 * 1024,  // 1MB
    });
    let xrpcServerForWebSocket: any = null;

    // Raw body parser for signature verification
    app.addContentTypeParser(
      ["application/activity+json", "application/ld+json", "application/json"],
      { parseAs: "string" },
      (req, body, done) => {
        done(null, body);
      }
    );

    // Health check endpoint
    app.get("/health", async () => {
      return {
        status: "ok",
        version: config.version,
        uptime: process.uptime(),
        startup: snapshotStartupState(),
      };
    });

    // Readiness check endpoint
    app.get("/ready", async (_request, reply) => {
      if (!queue) {
        reply.code(503);
        return {
          status: "not_ready",
          reason: "Queue not initialized",
          startup: snapshotStartupState(),
        };
      }

      const startup = snapshotStartupState();
      if (startup.phase !== "ready") {
        reply.code(503);
        return {
          status: startup.phase === "failed" ? "startup_failed" : "starting",
          startup,
        };
      }
      
      const [outboundPending, inboundPending, outboxIntentPending] = await Promise.all([
        queue.getPendingCount("outbound"),
        queue.getPendingCount("inbound"),
        queue.getPendingCount("outbox_intent"),
      ]);
      
      return {
        status: "ready",
        startup,
        queues: {
          outbound: { pending: outboundPending },
          inbound: { pending: inboundPending },
          outboxIntent: { pending: outboxIntentPending },
        },
        workers: {
          outbound: config.enableOutboundWorker,
          inbound: config.enableInboundWorker,
          outboxIntent: config.enableOutboxIntentWorker,
          opensearch: config.enableOpenSearchIndexer,
        },
      };
    });

    // Metrics endpoint (Prometheus format)
    app.get("/metrics", async () => {
      if (!queue) {
        return "# Queue not initialized\n";
      }
      
      const [
        outboundPending,
        inboundPending,
        outboxIntentPending,
        outboundLength,
        inboundLength,
        outboxIntentLength,
      ] = await Promise.all([
        queue.getPendingCount("outbound"),
        queue.getPendingCount("inbound"),
        queue.getPendingCount("outbox_intent"),
        queue.getStreamLength("outbound"),
        queue.getStreamLength("inbound"),
        queue.getStreamLength("outbox_intent"),
      ]);

      promMetrics.queueDepth.set({ topic: "outbound" }, outboundLength);
      promMetrics.queueDepth.set({ topic: "inbound" }, inboundLength);
      promMetrics.queueDepth.set({ topic: "outbox_intent" }, outboxIntentLength);
      const prometheusMetrics = (await renderPrometheusMetrics()).trimEnd();

      return [
        prometheusMetrics,
        `# HELP fedify_outbound_pending Number of pending outbound jobs`,
        `# TYPE fedify_outbound_pending gauge`,
        `fedify_outbound_pending ${outboundPending}`,
        `# HELP fedify_inbound_pending Number of pending inbound envelopes`,
        `# TYPE fedify_inbound_pending gauge`,
        `fedify_inbound_pending ${inboundPending}`,
        `# HELP fedify_outbox_intent_pending Number of pending outbox intents`,
        `# TYPE fedify_outbox_intent_pending gauge`,
        `fedify_outbox_intent_pending ${outboxIntentPending}`,
        `# HELP fedify_outbound_stream_length Total outbound stream length`,
        `# TYPE fedify_outbound_stream_length gauge`,
        `fedify_outbound_stream_length ${outboundLength}`,
        `# HELP fedify_inbound_stream_length Total inbound stream length`,
        `# TYPE fedify_inbound_stream_length gauge`,
        `fedify_inbound_stream_length ${inboundLength}`,
        `# HELP fedify_outbox_intent_stream_length Total outbox intent stream length`,
        `# TYPE fedify_outbox_intent_stream_length gauge`,
        `fedify_outbox_intent_stream_length ${outboxIntentLength}`,
        `# HELP fedify_uptime_seconds Uptime in seconds`,
        `# TYPE fedify_uptime_seconds gauge`,
        `fedify_uptime_seconds ${Math.floor(process.uptime())}`,
        ...renderOAuthSecurityMetricsLines(),
      ].filter((line) => line.length > 0).join("\n") + "\n";
    });

    if (config.enableMrfAdminApi) {
      const registration = await registerMrfAdminIntegration({
        app,
        logger,
        enabled: config.enableMrfAdminApi,
        adminToken: config.mrfAdminToken,
        storeMode: config.mrfAdminStore,
        redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
        redisPrefix: config.mrfAdminRedisPrefix,
      });
      mrfAdminRedisClient = registration.redisClient;
    }

    // Shared inbox endpoint
    const enqueueRawInboundRequest = async (
      request: FastifyRequest,
      reply: FastifyReply,
      path: string,
    ): Promise<void> => {
      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }

      const envelope = createInboundEnvelope({
        method: "POST",
        path,
        headers: normalizeHeaders(request.headers),
        body: request.body as string,
        remoteIp: request.ip,
      });

      await queue.enqueueInbound(envelope);
      reply.status(202).send({ accepted: true, envelopeId: envelope.envelopeId });
    };

    // Shared inbox uses Fedify as the primary verifier/router when enabled.
    // Actor-specific inboxes stay on the sidecar-native verifier so the sidecar
    // never needs local private keys to satisfy Fedify's authenticated
    // document-loading path.
    if (!fedifyAdapter) {
      app.post("/inbox", async (request, reply) => {
        await enqueueRawInboundRequest(request, reply, "/inbox");
      });
    }

    app.post("/users/:username/inbox", async (request, reply) => {
      const { username } = request.params as { username: string };
      await enqueueRawInboundRequest(request, reply, `/users/${username}/inbox`);
    });

    // Legacy compatibility alias. Canonical actor documents advertise
    // /users/:identifier/inbox, but we keep this fallback route to avoid
    // breaking older callers during the Fedify ingress migration.
    app.post("/:username/inbox", async (request, reply) => {
      const { username } = request.params as { username: string };
      await enqueueRawInboundRequest(request, reply, `/${username}/inbox`);
    });

    // Outbound webhook — receives delivery work from ActivityPods
    app.post("/webhook/outbox", async (request, reply) => {
      const requestStartedAt = Date.now();
      const authHeader = (request.headers["authorization"] as string) || "";
      const [scheme, token] = authHeader.split(" ");
      if (scheme !== "Bearer" || token !== config.sidecarToken) {
        promMetrics.outboundWebhookRequestsTotal.inc({ status: "unauthorized" });
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      let body: Record<string, unknown> | null = null;
      if (typeof request.body === "string") {
        try {
          const parsed = JSON.parse(request.body) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          body = null;
        }
      } else if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
        body = request.body as Record<string, unknown>;
      }

      const actorUri = body?.["actorUri"];
      const activity = body?.["activity"];
      const remoteTargets = body?.["remoteTargets"];
      if (
        typeof actorUri !== "string"
        || actorUri.length === 0
        || !activity
        || typeof activity !== "object"
        || Array.isArray(activity)
        || !Array.isArray(remoteTargets)
      ) {
        promMetrics.outboundWebhookRequestsTotal.inc({ status: "invalid" });
        reply.status(400).send({ error: "Bad Request" });
        return;
      }

      const bodyRecord = body as Record<string, unknown>;
      const activityRecord = activity as Record<string, unknown>;
      const metaValue = bodyRecord["meta"];
      const normalizedMeta = metaValue && typeof metaValue === "object" && !Array.isArray(metaValue)
        ? metaValue
        : undefined;

      if (!queue || !config.enableOutboxIntentWorker) {
        promMetrics.outboundWebhookRequestsTotal.inc({ status: "unavailable" });
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }

      try {
        const normalizedTargets = normalizeAndDedupeOutboundTargets(
          remoteTargets,
          outboundWebhookBackpressureConfig,
        );
        promMetrics.outboundWebhookTargetCount.observe(normalizedTargets.inputTargetCount);
        if (normalizedTargets.invalidTargetCount > 0) {
          promMetrics.outboundWebhookTargetsDedupedTotal.inc(
            { reason: "invalid" },
            normalizedTargets.invalidTargetCount,
          );
        }
        if (normalizedTargets.duplicateTargetCount > 0) {
          promMetrics.outboundWebhookTargetsDedupedTotal.inc(
            { reason: "duplicate" },
            normalizedTargets.duplicateTargetCount,
          );
        }

        const activityIdValue = bodyRecord["activityId"];
        const activityId = typeof activityIdValue === "string" && activityIdValue.trim().length > 0
          ? activityIdValue
          : typeof activityRecord["id"] === "string" && activityRecord["id"].trim().length > 0
            ? activityRecord["id"]
            : null;
        if (!activityId) {
          throw new OutboundWebhookValidationError(
            "OUTBOUND_ACTIVITY_ID_MISSING",
            400,
            "activityId is required when activity.id is not present.",
          );
        }

        const [outboundPending, outboundLength, outboxIntentPending, outboxIntentLength] = await Promise.all([
          queue.getPendingCount("outbound"),
          queue.getStreamLength("outbound"),
          queue.getPendingCount("outbox_intent"),
          queue.getStreamLength("outbox_intent"),
        ]);
        const backpressure = evaluateOutboundWebhookBackpressure(
          {
            pendingCount: Math.max(outboundPending, outboxIntentPending),
            streamLength: Math.max(outboundLength, outboxIntentLength),
          },
          outboundWebhookBackpressureConfig,
        );

        if (backpressure.reject) {
          promMetrics.outboundWebhookRequestsTotal.inc({ status: "backpressure" });
          promMetrics.outboundWebhookBackpressureRejectionsTotal.inc({
            reason: backpressure.reason ?? "pending",
          });
          if (backpressure.retryAfterSeconds) {
            reply.header("retry-after", backpressure.retryAfterSeconds.toString());
          }
          reply.status(503).send({
            error: "Outbound delivery queue is under backpressure",
            reason: backpressure.reason,
            retryAfterSeconds: backpressure.retryAfterSeconds,
          });
          return;
        }

        const bridgeValue = bodyRecord["bridge"];
        const activityPubHints =
          bridgeValue && typeof bridgeValue === "object" && !Array.isArray(bridgeValue)
            ? (bridgeValue as Record<string, unknown>)["activityPubHints"]
            : undefined;
        const bridgeHints = activityPubHints && typeof activityPubHints === "object" && !Array.isArray(activityPubHints)
          ? activityPubHints as Record<string, unknown>
          : undefined;
        const intent = createOutboxIntent({
          activityId,
          actorUri,
          activity: JSON.stringify(activityRecord),
          targets: normalizedTargets.targets,
          ...(normalizedMeta ? { meta: normalizedMeta } : {}),
          ...(bridgeHints ? { bridgeHints } : {}),
        });

        await queue.enqueueOutboxIntent(intent);

        const queueingLatencySeconds = (Date.now() - requestStartedAt) / 1000;
        promMetrics.outboundWebhookQueueingLatency.observe(queueingLatencySeconds);
        promMetrics.outboundWebhookRequestsTotal.inc({ status: "accepted" });

        reply.status(202).send({
          accepted: true,
          intentId: intent.intentId,
          jobCount: normalizedTargets.targets.length,
          inputTargetCount: normalizedTargets.inputTargetCount,
          duplicateTargetCount: normalizedTargets.duplicateTargetCount,
          invalidTargetCount: normalizedTargets.invalidTargetCount,
          queueingLatencyMs: Math.round(queueingLatencySeconds * 1000),
        });
      } catch (error) {
        if (error instanceof OutboundWebhookValidationError) {
          promMetrics.outboundWebhookRequestsTotal.inc({ status: "invalid" });
          reply.status(error.statusCode).send({
            error: error.message,
            code: error.code,
          });
          return;
        }
        promMetrics.outboundWebhookRequestsTotal.inc({ status: "error" });
        logger.error("Outbound webhook processing failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        reply.status(500).send({ error: "Internal server error" });
      }
    });

    // -----------------------------------------------------------------------
    // Fedify 2.x HTTP routes (WebFinger, NodeInfo, actor documents)
    // Only registered when the runtime integration flag is on.
    // -----------------------------------------------------------------------
    if (fedifyAdapter) {
      registerFedifyRoutes(app, fedifyAdapter);
      logger.info(
        "Fedify HTTP routes registered (WebFinger, NodeInfo, actor dispatch, verified inbox ingress)",
      );
    }

    // -----------------------------------------------------------------------
    // Phase 7: AT XRPC Server
    // Wire all /xrpc/* routes and the subscribeRepos WebSocket endpoint onto
    // the already-listening Fastify app.
    //
    // All concrete dependencies are now wired.  The signing client (already
    // instantiated above) is adapted to the SigningService interface so it can
    // be consumed by DefaultAtCommitBuilder without a separate HTTP adapter.
    // -----------------------------------------------------------------------
    if (config.enableXrpcServer) {
      try {
        const { DefaultAtXrpcServer } = await import("./at-adapter/xrpc/AtXrpcServer.js");

        // ---- Shared Redis client for AT adapter stores ----
        const atRedis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
        atRedisClient = atRedis;
        atRedis.on("error", (err: Error) =>
          logger.error("AT Redis client error", { error: err.message }),
        );

        // ---- Identity binding repository ----
        const identityRepo = new RedisIdentityBindingRepository(atRedis);

        // ---- Repo / alias stores ----
        const aliasStore   = new RedisAtAliasStore(atRedis);
        const repoRegistry = new RedisAtprotoRepoRegistry(atRedis);

        // ---- Handle resolution ----
        const handleResolutionReader = new DefaultHandleResolutionReader(identityRepo);

        // ---- Record reader + CAR exporter ----
        const recordReader = new DefaultAtRecordReader(
          handleResolutionReader,
          aliasStore,
          repoRegistry,
        );
        const carExporter = new DefaultAtCarExporter(repoRegistry);

        // ---- Firehose ----
        const firehoseCursorStore   = new RedisAtFirehoseCursorStore(atRedis, {
          maxEvents: config.atFirehoseCursorMaxEvents,
        });
        const firehoseSubscriptions = new DefaultAtFirehoseSubscriptionManager(firehoseCursorStore);
        const firehosePublisher     = new DefaultAtFirehosePublisher(
          new DefaultAtFirehoseEventEncoder(),
          firehoseCursorStore,
          firehoseSubscriptions,
          new DefaultAtRepoDiffBuilder(),
        );

        // ---- Session service ----
        const sessionSecret =
          config.atSessionSecret ||
          "dev-session-secret-at-least-32-characters";
        const sessionEndpointEnabled = true;
        let sessionService: any = undefined;
        let accountResolverForSession: any = undefined;
        let passwordVerifierForSession: any = undefined;
        let oauthTokenVerifier: OAuthAccessTokenVerifier | undefined = undefined;
        let identityBindingSyncService: HttpIdentityBindingSyncService | undefined = undefined;
        const externalPdsClient = new ExternalPdsClient({
          timeoutMs: config.externalPdsTimeoutMs,
          maxAttempts: config.externalPdsMaxAttempts,
        });
        const externalAtSessionStore = new RedisExternalAtSessionStore(
          atRedis,
          process.env["EXTERNAL_AT_SESSION_KEY_HEX"] ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          config.externalAtSessionTtlSeconds,
        );
        const externalWriteGateway = new ExternalWriteGateway(
          externalPdsClient,
          externalAtSessionStore,
          process.env["AT_OAUTH_CLIENT_ID"] ?? config.atOauthIssuer.replace(/\/$/, '') + '/oauth/atproto-sidecar.client.json',
        );
        const externalReadGateway = new ExternalReadGateway(externalPdsClient);
        if (sessionEndpointEnabled) {
          const sessionFamilyStateStore = new RedisSessionFamilyStateStore(atRedis);
          const tokenService    = new DefaultAtSessionTokenService({
            secret: sessionSecret,
            sessionStateStore: sessionFamilyStateStore,
          });
          identityBindingSyncService = config.atLocalFixture
            ? undefined
            : new HttpIdentityBindingSyncService({
                backendBaseUrl: process.env["ACTIVITYPODS_URL"]!,
                bearerToken: process.env["ACTIVITYPODS_TOKEN"]!,
                identityBindingRepository: identityRepo,
                repoRegistry,
                logger,
              });

          if (identityBindingSyncService) {
          logger.info("AT identity sync enabled", {
              backendBaseUrl: process.env["ACTIVITYPODS_URL"],
            });
          }

          const accountResolver = new DefaultAtAccountResolver(
            identityRepo,
            identityBindingSyncService,
            logger,
          );

          // Local fixture mode: bypass ActivityPods auth (dev/test only)
          const passwordVerifier = config.atLocalFixture
            ? new LocalAtPasswordVerifier()
            : createHttpAtPasswordVerifier({
                baseUrl: process.env["ACTIVITYPODS_URL"] ?? "http://localhost:3000",
                token:   process.env["ACTIVITYPODS_TOKEN"] ?? "",
              });

          accountResolverForSession  = accountResolver;
          passwordVerifierForSession = passwordVerifier;
          sessionService = new DefaultAtSessionService(
            accountResolver,
            passwordVerifier,
            tokenService,
            externalPdsClient,
            externalAtSessionStore,
          );
        }

        // ---- Signing adapter (SigningClient → SigningService) ----
        // Local fixture mode: use in-process secp256k1 signing from Redis-stored keys.
        // Production mode:    proxy signing calls to the ActivityPods signing API.
        const signingServiceAdapter: SigningService = config.atLocalFixture
          ? new LocalAtSigningService(atRedis)
          : {
              signAtprotoCommit:  (req) => signingClient.signAtprotoCommit(req),
              signPlcOperation:   (req) => signingClient.signAtprotoPlcOp(req),
              getAtprotoPublicKey: (req) => signingClient.getAtprotoPublicKey(req),
              generateApSigningKey: () => { throw new Error("generateApSigningKey not available via sidecar"); },
              generateAtSigningKey: () => { throw new Error("generateAtSigningKey not available via sidecar"); },
              getApPublicKey:       () => { throw new Error("getApPublicKey not available via sidecar"); },
            };

        // ---- Event publisher adapter ----
        // All AT-native writes and ingress audit events should hit the same
        // RedPanda-backed event bus implementation so we keep a single durable
        // audit path and avoid silent write-side drops.
        atEventPublisher = new RedpandaEventPublisher({
          brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092")
            .split(",")
            .map((broker) => broker.trim())
            .filter(Boolean),
          clientId: `${process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar"}-events`,
          compression: (process.env["REDPANDA_COMPRESSION"] || "zstd") as
            | "none"
            | "gzip"
            | "snappy"
            | "lz4"
            | "zstd",
          connectionTimeoutMs: Number.parseInt(
            process.env["REDPANDA_CONNECTION_TIMEOUT"] || "10000",
            10,
          ),
          requestTimeoutMs: Number.parseInt(
            process.env["REDPANDA_REQUEST_TIMEOUT"] || "30000",
            10,
          ),
          source: "fedify-sidecar.at-native",
        });
        const eventPublisherAdapter: EventPublisher = atEventPublisher;

        atFirehoseRuntime = new AtFirehoseRuntime({
          config: {
            brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092")
              .split(",")
              .map((broker) => broker.trim())
              .filter(Boolean),
            clientId: process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar",
            consumerGroupId: config.atFirehoseConsumerGroupId,
            commitTopic: "at.commit.v1",
            identityTopic: "at.identity.v1",
            accountTopic: "at.account.v1",
          },
          publisher: firehosePublisher,
          logger: {
            info: (message, meta) => logger.info(meta || {}, message),
            warn: (message, meta) => logger.warn(meta || {}, message),
            error: (message, meta) => logger.error(meta || {}, message),
          },
        });

        // ---- Projection worker ----
        const blobStore             = new DefaultAtBlobStore();
        const blobReferenceMapper   = new DefaultBlobReferenceMapper();
        const blobUploadService     = new DefaultAtBlobUploadService(blobStore, blobReferenceMapper);
        const profileMediaStore     = new RedisBridgeProfileMediaStore(atRedis, {
          ttlSeconds: config.protocolBridgeProfileMediaTtlSec,
        });
        const postMediaStore        = new RedisBridgePostMediaStore(atRedis, {
          ttlSeconds: config.protocolBridgePostMediaTtlSec,
        });
        const bridgeRasterImageClient = new ActivityPubBridgeProfileMediaClient({
          activityPodsBaseUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
          bearerToken: process.env["ACTIVITYPODS_TOKEN"] || "",
          timeoutMs: config.protocolBridgeProfileMediaTimeoutMs,
          maxMediaBytes: config.protocolBridgeProfileMediaMaxBytes,
        });
        const bridgeAttachmentMediaClient = new ActivityPubBridgeMediaClient({
          activityPodsBaseUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
          bearerToken: process.env["ACTIVITYPODS_TOKEN"] || "",
          timeoutMs: config.protocolBridgeAttachmentMediaTimeoutMs,
          maxMediaBytes: config.protocolBridgeAttachmentMediaMaxBytes,
        });
        const profileMediaResolver  = config.enableProtocolBridgeApToAt
          ? new AtprotoProfileMediaResolver(
              profileMediaStore,
              bridgeRasterImageClient,
              blobUploadService,
              {
                warn: (message, meta) => logger.warn(meta || {}, message),
                error: (message, meta) => logger.error(meta || {}, message),
              },
            )
          : { resolveAvatarBlob: async () => null, resolveBannerBlob: async () => null };
        const attachmentMediaResolver = new StoredAttachmentMediaResolver(postMediaStore, {
          warn: (message, meta) => logger.warn(meta || {}, message),
        });
        const rkeyService          = new DefaultAtRkeyService();
        const recordRefResolver    = new DefaultAtRecordRefResolver(aliasStore);
        const subjectResolver      = new DefaultAtSubjectResolver(identityRepo);
        const targetAliasResolver  = new DefaultAtTargetAliasResolver(aliasStore);
        const commitBuilder        = new DefaultAtCommitBuilder(signingServiceAdapter);
        const persistenceService   = new DefaultAtCommitPersistenceService(
          aliasStore,
          eventPublisherAdapter,
          atRedis,
        );

        const projectionWorker = new DefaultAtProjectionWorker(
          new DefaultAtProjectionPolicy(),
          identityRepo,
          repoRegistry,
          new DefaultProfileRecordSerializer(),
          new DefaultPostRecordSerializer(),
          new DefaultStandardDocumentRecordSerializer(),
          rkeyService,
          aliasStore,
          commitBuilder,
          persistenceService,
          eventPublisherAdapter,
          {
            mediaResolver:       profileMediaResolver,
            facetBuilder:        new DefaultFacetBuilder(),
            embedBuilder:        new DefaultEmbedBuilder(
              new DefaultImageEmbedBuilder(blobUploadService, attachmentMediaResolver),
              new DefaultVideoEmbedBuilder(blobUploadService, attachmentMediaResolver),
            ),
            recordRefResolver,
            subjectResolver,
            targetAliasResolver,
            followSerializer:    new DefaultFollowRecordSerializer(),
            likeSerializer:      new DefaultLikeRecordSerializer(),
            repostSerializer:    new DefaultRepostRecordSerializer(),
          },
        );

        // ---- Write gateway ----
        const resultStore   = new RedisAtWriteResultStore({
          redis: atRedis,
          resultTtlSec: Number.isFinite(config.atWriteResultTtlSec)
            ? config.atWriteResultTtlSec
            : 120,
          keyPrefix: config.atWriteResultKeyPrefix,
          channelPrefix: config.atWriteResultChannelPrefix,
        });
        writeResultStore = resultStore;
        const writeService  = new DefaultCanonicalClientWriteService({
          projectionWorker,
          aliasStore,
          resultStore,
          identityRepo,
          profileMediaStore,
          postMediaStore,
        });
        const writeGateway  = new DefaultAtWriteGateway({
          normalizer:  new DefaultAtWriteNormalizer(),
          policyGate:  new DefaultAtWritePolicyGate(identityRepo, aliasStore),
          writeService,
          resultStore,
          identityBindingSyncService,
          logger,
        });

        if (
          config.enableProtocolBridgeApToAt ||
          config.enableProtocolBridgeAtToAp
        ) {
          const { translationContext, projectionContext } = createProtocolBridgeContexts(
            identityRepo,
            aliasStore,
            {
              localPdsOrigin: config.atOauthResourceServerOrigin,
              ...(config.enableProtocolBridgeApToAt
                ? {
                    activityResolver: new ActivityPubBridgeActivityResolverClient({
                      activityPodsBaseUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
                      bearerToken: process.env["ACTIVITYPODS_TOKEN"] || "",
                      timeoutMs: config.protocolBridgeActivityResolutionTimeoutMs,
                    }),
                  }
                : {}),
            },
          );
          const projectionLedger = new RedisProjectionLedger(atRedis, {
            ttlSeconds: config.protocolBridgeLedgerTtlSec,
          });
          const allowAllPolicy = {
            evaluate: async () => ({ allowed: true }),
          };
          const bridgeAtWritePort = new AtprotoWriteGatewayPort(
            writeGateway,
            accountResolverForSession,
            config.enableProtocolBridgeApToAt
              ? {
                  attachmentMediaResolver: new AtprotoAttachmentMediaResolver(
                    bridgeAttachmentMediaClient,
                    blobUploadService,
                    {
                      warn: (message, meta) => logger.warn(meta || {}, message),
                      error: (message, meta) => logger.error(meta || {}, message),
                    },
                  ),
                  linkPreviewThumbResolver: new AtprotoLinkPreviewThumbResolver(
                    bridgeRasterImageClient,
                    blobUploadService,
                    {
                      warn: (message, meta) => logger.warn(meta || {}, message),
                      error: (message, meta) => logger.error(meta || {}, message),
                    },
                  ),
                  logger: {
                    warn: (message, meta) => logger.warn(meta || {}, message),
                  },
                }
              : undefined,
          );
          const bridgeApPublishPort = config.enableProtocolBridgeAtToAp
            ? new EventPublisherActivityPubPort(
                eventPublisherAdapter,
                {
                  outboundResolver: new ActivityPubBridgeOutboundResolverClient({
                    activityPodsBaseUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
                    bearerToken: process.env["ACTIVITYPODS_TOKEN"] || "",
                    timeoutMs: config.protocolBridgeOutboundResolutionTimeoutMs,
                  }),
                  deliveryPolicy: activityPubOutboundDeliveryPolicy,
                },
              )
            : undefined;
          const bridgeApIngressForwarder = config.enableProtocolBridgeAtToAp
            ? new ActivityPubBridgeIngressClient({
                activityPodsBaseUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
                bearerToken: process.env["ACTIVITYPODS_TOKEN"] || "",
                timeoutMs: config.protocolBridgeIngressTimeoutMs,
              })
            : undefined;

          const canonicalPublisher = config.enableCanonicalEventLog && atEventPublisher
            ? new CanonicalIntentPublisher(atEventPublisher, config.canonicalTopic)
            : undefined;

          const canonicalNotificationConsumer = config.enableCanonicalNotifications && atEventPublisher
            ? new CanonicalNotificationConsumer(
                {
                  brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092")
                    .split(",")
                    .map((broker) => broker.trim())
                    .filter(Boolean),
                  clientId: process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar",
                  consumerGroupId: `${config.protocolBridgeConsumerGroupId}-canonical-notifications`,
                  canonicalTopic: config.canonicalTopic,
                  activityPodsBaseUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
                  activityPodsBearerToken: process.env["ACTIVITYPODS_TOKEN"] || "",
                },
                {
                  info: (message, meta) => logger.info(meta || {}, message),
                  warn: (message, meta) => logger.warn(meta || {}, message),
                  error: (message, meta) => logger.error(meta || {}, message),
                },
              )
            : undefined;

          protocolBridgeRuntime = new ProtocolBridgeRuntime({
            config: {
              brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092")
                .split(",")
                .map((broker) => broker.trim())
                .filter(Boolean),
              clientId: process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar",
              consumerGroupId: config.protocolBridgeConsumerGroupId,
              apSourceTopic: config.protocolBridgeApSourceTopic,
              atCommitTopic: config.protocolBridgeAtCommitTopic,
              atVerifiedIngressTopic: config.protocolBridgeAtVerifiedIngressTopic,
              apIngressTopic: config.protocolBridgeApIngressTopic,
              enableApToAt: config.enableProtocolBridgeApToAt,
              enableAtToAp: config.enableProtocolBridgeAtToAp,
            },
            translationContext,
            apToAtWorker: config.enableProtocolBridgeApToAt
              ? new ApToAtProjectionWorker(
                  new ActivityPubToCanonicalTranslator(),
                  new CanonicalToAtprotoProjector(),
                  allowAllPolicy,
                  projectionLedger,
                  bridgeAtWritePort,
                  projectionContext,
                  undefined,
                  canonicalPublisher,
                )
              : undefined,
            atToApWorker: config.enableProtocolBridgeAtToAp
              ? new AtToApProjectionWorker(
                  new AtprotoToCanonicalTranslator(),
                  new CanonicalToActivityPubProjector({
                    noteLinkPreviewMode: config.protocolBridgeApNoteLinkPreviewMode,
                  }),
                  allowAllPolicy,
                  projectionLedger,
                  bridgeApPublishPort!,
                  projectionContext,
                  undefined,
                  canonicalPublisher,
                )
              : undefined,
            apIngressForwarder: bridgeApIngressForwarder,
            canonicalNotificationConsumer,
            logger: {
              info: (message, meta) => logger.info(meta || {}, message),
              warn: (message, meta) => logger.warn(meta || {}, message),
              error: (message, meta) => logger.error(meta || {}, message),
            },
          });
        }

        // ---- OAuth Authorization Server + metadata/route bridge ----
        if (config.enableAtprotoOauth) {
          const oauthParStore = new OAuthParStore(atRedis);
          const oauthCodeStore = new OAuthAuthorizationCodeStore(atRedis);
          const oauthRefreshStore = new OAuthRefreshTokenStore(atRedis);
          const oauthGrantStore = new OAuthGrantStore(atRedis);
          const oauthNonceStore = new OAuthDpopNonceStore(atRedis);
          const oauthConsentChallengeStore = new OAuthConsentChallengeStore(atRedis);
          const oauthRateLimitStore = new OAuthRateLimitStore(atRedis);
          const oauthKeyManager = new OAuthAsKeyManager(atRedis);
          const oauthClientMetadataFetcher = new OAuthClientMetadataFetcher(
            config.atOauthClientMetadataTimeoutMs,
            config.atOauthClientMetadataMaxAttempts,
            config.atOauthAllowLocalhostHttpDiscovery,
          );
          const oauthExternalDiscoveryBroker = new OAuthExternalDiscoveryBroker({
            timeoutMs: config.atOauthExternalDiscoveryTimeoutMs,
            maxAttempts: config.atOauthExternalDiscoveryMaxAttempts,
            allowLocalhostHttp: config.atOauthAllowLocalhostHttpDiscovery,
          });

          const oauthAuthorizationServer = new OAuthAuthorizationServer({
            issuer: config.atOauthIssuer,
            authorizationServerOrigin: config.atOauthAuthorizationServerOrigin,
            resourceServerOrigin: config.atOauthResourceServerOrigin,
            keyManager: oauthKeyManager,
            clientMetadataFetcher: oauthClientMetadataFetcher,
            parStore: oauthParStore,
            codeStore: oauthCodeStore,
            refreshStore: oauthRefreshStore,
            grantStore: oauthGrantStore,
            nonceStore: oauthNonceStore,
          });
          await oauthAuthorizationServer.initialize();

          const dpopVerifier = new DpopVerifier(oauthNonceStore);

          const localOauthTokenVerifier = new OAuthTokenVerifier({
            issuer: config.atOauthIssuer,
            resourceServerOrigin: config.atOauthResourceServerOrigin,
            keyManager: oauthKeyManager,
            dpopVerifier,
            nonceFactory: () => oauthAuthorizationServer.mintDpopNonce(),
          });

          oauthTokenVerifier = localOauthTokenVerifier;

          if (process.env["ACTIVITYPODS_URL"] && process.env["ACTIVITYPODS_TOKEN"]) {
            const backendOauthTokenVerifier = new BackendIntrospectionTokenVerifier({
              introspectionUrl: `${process.env["ACTIVITYPODS_URL"].replace(/\/$/, '')}/api/internal/oauth/introspect`,
              introspectionBearerToken: process.env["ACTIVITYPODS_TOKEN"],
              dpopVerifier,
              nonceFactory: () => oauthAuthorizationServer.mintDpopNonce(),
              identityBindings: identityRepo,
              timeoutMs: config.atOauthBackendIntrospectionTimeoutMs,
              maxAttempts: config.atOauthBackendIntrospectionMaxAttempts,
            });

            oauthTokenVerifier = new CompositeOAuthTokenVerifier([
              localOauthTokenVerifier,
              backendOauthTokenVerifier,
            ]);
          }

          registerOAuthRoutes(app, {
            authorizationServer: oauthAuthorizationServer,
            dpopVerifier,
            sessionService,
            externalDiscoveryBroker: oauthExternalDiscoveryBroker,
            consentChallengeStore: oauthConsentChallengeStore,
            rateLimitStore: oauthRateLimitStore,
            rateLimits: config.atOauthRouteRateLimits,
          });

          logger.info("AT OAuth routes registered", {
            issuer: config.atOauthIssuer,
            authorizationServerOrigin: config.atOauthAuthorizationServerOrigin,
            resourceServerOrigin: config.atOauthResourceServerOrigin,
            routeRateLimits: config.atOauthRouteRateLimits,
          });
        }

        // ---- Internal AT session mint (trusted backend-only path) ----
        // Used by ActivityPods dashboard/services to obtain a short-lived
        // AT access token for managed accounts without requiring an app password.
        app.post('/api/internal/atproto/session', async (request, reply) => {
          const authHeader = (request.headers.authorization as string | undefined) ?? '';
          const [scheme, token] = authHeader.split(' ');
          if (scheme !== 'Bearer' || token !== (process.env['ACTIVITYPODS_TOKEN'] || '')) {
            reply.status(401).send({ error: 'Unauthorized' });
            return;
          }

          if (!sessionService) {
            reply.status(503).send({ error: 'Session service unavailable' });
            return;
          }

          let rawBody: Record<string, unknown> | undefined;
          if (typeof request.body === 'string') {
            try {
              const parsed = JSON.parse(request.body);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                rawBody = parsed as Record<string, unknown>;
              }
            } catch {
              rawBody = undefined;
            }
          } else if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
            rawBody = request.body as Record<string, unknown>;
          }

          const canonicalAccountId = typeof rawBody?.['canonicalAccountId'] === 'string'
            ? rawBody['canonicalAccountId'].trim()
            : '';

          if (!canonicalAccountId) {
            reply.status(400).send({ error: 'canonicalAccountId is required' });
            return;
          }

          const binding = await identityRepo.getByCanonicalAccountId(canonicalAccountId);
          if (!binding || !binding.atprotoDid || !binding.atprotoHandle) {
            reply.status(404).send({ error: 'ATProto identity binding not found' });
            return;
          }

          const isExternal = binding.atprotoManaged === false || binding.atprotoSource === 'external';
          if (isExternal) {
            reply.status(403).send({ error: 'External accounts require delegated credentials' });
            return;
          }

          const accessJwt = await sessionService.mintAccessToken({
            canonicalAccountId,
            did: binding.atprotoDid,
            handle: binding.atprotoHandle,
            scope: 'full',
          });

          reply.status(200).send({
            accessJwt,
            did: binding.atprotoDid,
            handle: binding.atprotoHandle,
          });
        });

        // ---- Assemble XRPC server ----
        const xrpcServer = new DefaultAtXrpcServer({
          recordReader,
          carExporter,
          blobStore,
          handleResolutionReader,
          firehoseSubscriptions,
          repoRegistry,
          identityRepo,
          serverConfig: {
            hostname:           config.atPdsHostname,
            inviteCodeRequired: false,
            acceptsNewAccounts: false,
          },
          sessionService,
          accountResolver: accountResolverForSession,
          passwordVerifier: passwordVerifierForSession,
          writeGateway,
          externalWriteGateway,
          externalReadGateway,
        });

        registerAtXrpcRoutes(app, {
          xrpcServer,
          sessionService,
          oauthTokenVerifier,
        });
        xrpcServerForWebSocket = xrpcServer;

        if (config.enableModerationBridgeApi) {
          const moderationRegistration = await registerModerationBridgeIntegration({
            app,
            logger,
            enabled: config.enableModerationBridgeApi,
            adminToken: config.mrfAdminToken,
            storeMode: config.mrfAdminStore,
            redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
            redisPrefix: config.moderationBridgeRedisPrefix,
            identityBindingRepository: identityRepo,
            labelerDid: config.moderationLabelerDid,
            labelerSigningKeyHex: config.moderationLabelerSigningKeyHex || undefined,
            atAdminXrpcBaseUrl: config.moderationAtAdminXrpcBaseUrl || undefined,
            atAdminBearerToken: config.moderationAtAdminBearerToken || undefined,
            atAdminTimeoutMs: Number.isFinite(config.moderationAtAdminTimeoutMs)
              ? Math.max(1_000, config.moderationAtAdminTimeoutMs)
              : 5_000,
          });
          moderationBridgeRedisClient = moderationRegistration.redisClient;
        }

        if (!config.atLocalFixture) {
          identityWarmupService = new IdentityWarmupService({
            backendBaseUrl: process.env["ACTIVITYPODS_URL"]!,
            bearerToken: process.env["ACTIVITYPODS_TOKEN"]!,
            identityBindingRepository: identityRepo,
            cursorStore: new RedisIdentityWarmCursorStore(atRedis),
            repoRegistry,
            logger,
            intervalMs: config.identityWarmIntervalMs,
            batchLimit: config.identityWarmBatchLimit,
          });
        }

        startupTasks.push({
          name: "start AT runtime backplane",
          start: async () => {
            await atEventPublisher!.connect();
            await atFirehoseRuntime!.start();

            logger.info("AT firehose runtime enabled", {
              consumerGroupId: config.atFirehoseConsumerGroupId,
              commitTopic: "at.commit.v1",
              identityTopic: "at.identity.v1",
              accountTopic: "at.account.v1",
              cursorMaxEvents: config.atFirehoseCursorMaxEvents,
            });

            if (config.enableAtExternalFirehose) {
              try {
                const externalFirehoseSources = parseAtExternalFirehoseSources(
                  process.env["AT_EXTERNAL_FIREHOSE_SOURCES"],
                );
                const externalDidFailureCacheTtlMs = 60_000;
                const externalIdentityResolver = new HttpAtIdentityResolver({
                  fetchImpl: fetch,
                  timeoutMs: config.externalPdsTimeoutMs,
                  maxAttempts: config.externalPdsMaxAttempts,
                  failedResolutionCacheTtlMs: externalDidFailureCacheTtlMs,
                });
                const externalCommitVerifier = new ProductionAtCommitVerifier({
                  identityResolver: externalIdentityResolver,
                  repoRegistry,
                });
                const externalIngressBootstrap = buildAtExternalFirehoseBootstrap({
                  runtimeConfig: {
                    brokers: (process.env["REDPANDA_BROKERS"] || "localhost:9092")
                      .split(",")
                      .map((broker) => broker.trim())
                      .filter(Boolean),
                    clientId: process.env["REDPANDA_CLIENT_ID"] || "fedify-sidecar",
                    consumerGroupId: config.atExternalFirehoseConsumerGroupId,
                    rawTopic: config.atExternalFirehoseRawTopic,
                    sources: externalFirehoseSources,
                  },
                  redis: atRedis as any,
                  eventPublisher: eventPublisherAdapter,
                  repoRegistry,
                  commitVerifier: externalCommitVerifier,
                  logger: {
                    info: (message, meta) => logger.info(meta || {}, message),
                    warn: (message, meta) => logger.warn(meta || {}, message),
                    error: (message, meta) => logger.error(meta || {}, message),
                  },
                  identityResolverOptions: {
                    timeoutMs: config.externalPdsTimeoutMs,
                    maxAttempts: config.externalPdsMaxAttempts,
                    failedResolutionCacheTtlMs: externalDidFailureCacheTtlMs,
                  },
                  syncRebuilderOptions: {
                    fetchImpl: fetch,
                    timeoutMs: config.externalPdsTimeoutMs,
                    maxAttempts: config.externalPdsMaxAttempts,
                  },
                });

                if (externalIngressBootstrap.kind === "ready") {
                  await externalIngressBootstrap.runtime.start();
                  atExternalFirehoseRuntime = externalIngressBootstrap.runtime;

                  logger.info(
                    {
                      enableAtExternalFirehose: true,
                      sourceCount: externalIngressBootstrap.sources.length,
                      rawTopic: config.atExternalFirehoseRawTopic,
                      consumerGroupId: config.atExternalFirehoseConsumerGroupId,
                    },
                    "External AT firehose intake started",
                  );
                } else {
                  logger.warn(
                    {
                      enableAtExternalFirehose: true,
                      sourceCount: externalIngressBootstrap.sources.length,
                      rawTopic: config.atExternalFirehoseRawTopic,
                      consumerGroupId: config.atExternalFirehoseConsumerGroupId,
                      bootstrapStatus: externalIngressBootstrap.kind,
                      bootstrapReason: externalIngressBootstrap.reason,
                    },
                    `External AT firehose intake requested but not started: ${externalIngressBootstrap.message}`,
                  );
                }
              } catch (error: any) {
                logger.error(
                  {
                    enableAtExternalFirehose: true,
                    error: error?.message || String(error),
                  },
                  "External AT firehose intake requested but configuration validation failed",
                );
              }
            }

            if (protocolBridgeRuntime) {
              await protocolBridgeRuntime.start();

              logger.info("Protocol bridge runtime enabled", {
                enableApToAt: config.enableProtocolBridgeApToAt,
                enableAtToAp: config.enableProtocolBridgeAtToAp,
                apSourceTopic: config.protocolBridgeApSourceTopic,
                atCommitTopic: config.protocolBridgeAtCommitTopic,
                atVerifiedIngressTopic: config.protocolBridgeAtVerifiedIngressTopic,
                apIngressTopic: config.protocolBridgeApIngressTopic,
              });
            }

            if (identityWarmupService) {
              identityWarmupService.start();

              logger.info("AT identity warmup enabled", {
                backendBaseUrl: process.env["ACTIVITYPODS_URL"],
                intervalMs: config.identityWarmIntervalMs,
                batchLimit: config.identityWarmBatchLimit,
              });
            }

            if (config.enableAtJetstream) {
              atJetstreamService = new AtJetstreamService(
                atEventPublisher!,
                {
                  url: config.atJetstreamUrl,
                  publishTopic: config.atJetstreamPublishTopic,
                  maxEvents: config.atJetstreamMaxEvents,
                },
                {
                  info: (message, meta) => logger.info(meta ?? {}, message),
                  warn: (message, meta) => logger.warn(meta ?? {}, message),
                  error: (message, meta) => logger.error(meta ?? {}, message),
                },
              );
              atJetstreamService.onMaxEvents(() => {
                logger.info("Jetstream maxEvents reached — initiating graceful shutdown");
                process.emit("SIGTERM");
              });
              atJetstreamService.start();

              logger.info("AT Jetstream intake started", {
                url: config.atJetstreamUrl,
                publishTopic: config.atJetstreamPublishTopic,
                maxEvents: config.atJetstreamMaxEvents ?? null,
              });
            }
          },
        });

        if (config.atLocalFixture) {
          logger.warn(
            "AT_LOCAL_FIXTURE=true — LocalAtPasswordVerifier and LocalAtSigningService are active. " +
            "This mode bypasses ActivityPods auth and uses Redis-stored fixture keys. " +
            "NEVER use in production."
          );
        }

        logger.info("AT XRPC server routes registered", {
          hostname:              config.atPdsHostname,
          writeEndpointsEnabled: true,
          sessionEndpointEnabled,
          localFixtureMode:      config.atLocalFixture,
        });
      } catch (err: any) {
        logger.error({
          error: err.message,
          stack: err.stack,
        }, "Failed to initialise AT XRPC server");
      }
    }

    if (xrpcServerForWebSocket) {
      attachSubscribeReposWebSocket(app, xrpcServerForWebSocket);
    }

    // Start HTTP server only after all HTTP and WebSocket routes are registered.
    if (config.startupMode === "blocking") {
      await runStartupTasks(startupTasks);
    }

    await app.listen({ port: config.port, host: config.host });

    logger.info(`Fedify Sidecar listening on ${config.host}:${config.port}`);
    logger.info(`Metrics available at http://${config.host}:${config.port}/metrics`);
    logger.info("Configuration summary", {
      domain: config.domain,
      startupMode: config.startupMode,
      enableOutboundWorker: config.enableOutboundWorker,
      enableInboundWorker: config.enableInboundWorker,
      enableOpenSearchIndexer: config.enableOpenSearchIndexer,
    });

    if (config.startupMode === "background") {
      logger.info("HTTP server is listening while background startup continues", {
        pendingStartupTasks: startupTasks.map((task) => task.name),
      });

      void (async () => {
        try {
          await runStartupTasks(startupTasks);
          markStartupReady();
          logger.info("Background startup completed", {
            startup: snapshotStartupState(),
          });
        } catch (error: any) {
          logger.error(
            {
              error: error?.message || String(error),
              startup: snapshotStartupState(),
            },
            "Background startup failed",
          );
        }
      })();
    } else {
      markStartupReady();
      logger.info("Startup completed", {
        startup: snapshotStartupState(),
      });
    }

  } catch (error: any) {
    logger.error({ error: error.message, stack: error.stack }, "Failed to start Fedify Sidecar");
    process.exit(1);
  }
}

/**
 * Normalize headers to lowercase keys
 */
function normalizeHeaders(headers: Record<string, any>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value[0];
    }
  }
  return normalized;
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress");
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, 30000);

  try {
    // Stop relay subscription service
    if (apRelaySubscriptionService) {
      apRelaySubscriptionService.shutdown();
      logger.info("AP relay subscription service stopped");
    }

    if (atJetstreamService) {
      atJetstreamService.shutdown();
      logger.info("AT Jetstream service stopped");
    }

    // Stop workers first
    if (outboxIntentWorker) {
      await outboxIntentWorker.stop();
      logger.info("Outbox intent worker stopped");
    }

    if (outboundWorker) {
      await outboundWorker.stop();
      logger.info("Outbound worker stopped");
    }

    if (inboundWorker) {
      await inboundWorker.stop();
      logger.info("Inbound worker stopped");
    }

    if (opensearchIndexer) {
      await opensearchIndexer.stop();
      logger.info("OpenSearch indexer stopped");
    }

    // Disconnect queue
    if (queue) {
      await queue.disconnect();
      logger.info("Redis Streams queue disconnected");
    }

    // Close write-result store (drains pending waiters + quits subscriber)
    if (writeResultStore) {
      await writeResultStore.close();
      logger.info("Write result store closed");
    }

    if (identityWarmupService) {
      await identityWarmupService.stop();
      identityWarmupService = null;
      logger.info("Identity warmup service stopped");
    }

    if (atFirehoseRuntime) {
      await atFirehoseRuntime.stop();
      atFirehoseRuntime = null;
      logger.info("AT firehose runtime stopped");
    }

    if (atExternalFirehoseRuntime) {
      await atExternalFirehoseRuntime.stop();
      atExternalFirehoseRuntime = null;
      logger.info("External AT firehose runtime stopped");
    }

    if (protocolBridgeRuntime) {
      await protocolBridgeRuntime.stop();
      protocolBridgeRuntime = null;
      logger.info("Protocol bridge runtime stopped");
    }

    if (searchIndexerRedis) {
      await searchIndexerRedis.quit().catch(() => searchIndexerRedis!.disconnect());
      searchIndexerRedis = null;
      logger.info("Search indexer Redis client disconnected");
    }

    if (mrfAdminRedisClient) {
      await mrfAdminRedisClient.quit().catch(() => mrfAdminRedisClient!.disconnect());
      mrfAdminRedisClient = null;
      logger.info("MRF admin Redis client disconnected");
    }

    if (moderationBridgeRedisClient) {
      await moderationBridgeRedisClient.quit().catch(() => moderationBridgeRedisClient!.disconnect());
      moderationBridgeRedisClient = null;
      logger.info("Moderation bridge Redis client disconnected");
    }

    // Quit shared AT Redis client
    if (atRedisClient) {
      await atRedisClient.quit().catch(() => atRedisClient!.disconnect());
      logger.info("AT Redis client disconnected");
    }

    if (atEventPublisher) {
      await atEventPublisher.disconnect();
      atEventPublisher = null;
      logger.info("AT event publisher disconnected");
    }

    clearTimeout(shutdownTimeout);
    logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error: any) {
    logger.error("Error during shutdown", { error: error.message });
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// Start the application
main();
