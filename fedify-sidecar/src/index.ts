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

import Fastify from "fastify";
import { Redis } from "ioredis";
import {
  RedisStreamsQueue,
  createDefaultConfig as createQueueConfig,
  createInboundEnvelope,
  OutboundJob,
} from "./queue/sidecar-redis-queue.js";
import { createSigningClient } from "./signing/signing-client.js";
import { createRedPandaProducer } from "./streams/redpanda-producer.js";
import { createOpenSearchIndexer } from "./streams/opensearch-indexer.js";
import { createOutboundWorker, OutboundWorker } from "./delivery/outbound-worker.js";
import { createInboundWorker, InboundWorker } from "./delivery/inbound-worker.js";
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
import { RedisAtBlobStore } from "./at-adapter/blob/AtBlobStore.js";
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
import { buildAtExternalFirehoseBootstrap, parseAtExternalFirehoseSources } from "./at-adapter/ingress/AtExternalFirehoseBootstrap.js";
import { normalizeActivityPubNoteLinkPreviewMode } from "./protocol-bridge/projectors/activitypub/ActivityPubProjectionPolicy.js";
import {
  applyActivityPubOutboundDeliveryPolicy,
  normalizeActivityPubDomainRuleList,
} from "./protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";
import { ProtocolBridgeRuntime } from "./protocol-bridge/runtime/ProtocolBridgeRuntime.js";
import { createProtocolBridgeContexts } from "./protocol-bridge/runtime/createProtocolBridgeContexts.js";
import { RedisBridgeProfileMediaStore } from "./protocol-bridge/profile/BridgeProfileMedia.js";
import { RedisBridgePostMediaStore } from "./protocol-bridge/post/BridgePostMedia.js";
import { ApToAtProjectionWorker } from "./protocol-bridge/workers/ApToAtProjectionWorker.js";
import { AtToApProjectionWorker } from "./protocol-bridge/workers/AtToApProjectionWorker.js";
import {
  buildProviderCapabilities,
  inferProviderProfile,
  renderCapabilitiesResponse,
} from "./capabilities/provider-capabilities.js";
import { validateProviderCapabilitiesConfig } from "./capabilities/startup-validator.js";
import type { ProviderProfile } from "./capabilities/types.js";
import { evaluateCapabilityGate } from "./capabilities/gates.js";

// ============================================================================
// Configuration
// ============================================================================

type SidecarDeploymentSize = "small" | "medium" | "large";

const deploymentSize = (process.env.SIDECAR_DEPLOYMENT_SIZE || "medium") as SidecarDeploymentSize;

const sizeDefaults: Record<SidecarDeploymentSize, {
  inboundConcurrency: number;
  outboundConcurrency: number;
  maxConcurrentPerDomain: number;
  wsMaxConnections: number;
  wsIdleTimeoutMs: number;
  wsHeartbeatIntervalMs: number;
}> = {
  small: {
    inboundConcurrency: 16,
    outboundConcurrency: 32,
    maxConcurrentPerDomain: 5,
    wsMaxConnections: 1000,
    wsIdleTimeoutMs: 120000,
    wsHeartbeatIntervalMs: 30000,
  },
  medium: {
    inboundConcurrency: 32,
    outboundConcurrency: 64,
    maxConcurrentPerDomain: 10,
    wsMaxConnections: 5000,
    wsIdleTimeoutMs: 120000,
    wsHeartbeatIntervalMs: 30000,
  },
  large: {
    inboundConcurrency: 64,
    outboundConcurrency: 128,
    maxConcurrentPerDomain: 20,
    wsMaxConnections: 20000,
    wsIdleTimeoutMs: 90000,
    wsHeartbeatIntervalMs: 20000,
  },
};

const selectedSizeDefaults = sizeDefaults[deploymentSize] ?? sizeDefaults.medium;

const config = {
  version: process.env.VERSION || "5.0.0",
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "8080", 10),
  host: process.env.HOST || "0.0.0.0",
  domain: process.env.DOMAIN || "localhost",
  sidecarToken: process.env.SIDECAR_TOKEN || "",
  
  // Feature flags
  enableOutboundWorker: process.env.ENABLE_OUTBOUND_WORKER !== "false",
  enableInboundWorker: process.env.ENABLE_INBOUND_WORKER !== "false",
  enableOpenSearchIndexer: process.env.ENABLE_OPENSEARCH_INDEXER !== "false",
  enableXrpcServer: process.env.ENABLE_XRPC_SERVER !== "false",
  enableProtocolBridgeApToAt: process.env.ENABLE_PROTOCOL_BRIDGE_AP_TO_AT === "true",
  enableProtocolBridgeAtToAp: process.env.ENABLE_PROTOCOL_BRIDGE_AT_TO_AP === "true",
  enableProviderCapabilitiesEndpoint: process.env.ENABLE_PROVIDER_CAPABILITIES_ENDPOINT !== "false",
  enableProviderCapabilitiesValidation: process.env.ENABLE_PROVIDER_CAPABILITIES_VALIDATION === "true",
  providerId: process.env.PROVIDER_ID || process.env.DOMAIN || "localhost",
  providerDisplayName: process.env.PROVIDER_DISPLAY_NAME || "ActivityPods Provider",
  providerRegion: process.env.PROVIDER_REGION || "global",
  providerPlan: process.env.PROVIDER_PLAN || "pro",
  providerProfile: process.env.PROVIDER_PROFILE || "",
  providerAtprotoEnabledRaw: process.env.PROVIDER_ATPROTO_ENABLED,

  // Phase 7: AT session token secret (min 32 chars).
  // Required when ENABLE_XRPC_SERVER is true.
  atSessionSecret: process.env.AT_SESSION_SECRET || "",

  // Phase 7: PDS hostname advertised in server.describeServer
  atPdsHostname: process.env.AT_PDS_HOSTNAME || process.env.DOMAIN || "localhost",

  // ATProto OAuth settings
  enableAtprotoOauth: process.env.ENABLE_ATPROTO_OAUTH !== "false",
  atOauthIssuer: process.env.AT_OAUTH_ISSUER || "http://localhost:8080",
  atOauthAuthorizationServerOrigin:
    process.env.AT_OAUTH_AUTHORIZATION_SERVER_ORIGIN || "http://localhost:8080",
  atOauthResourceServerOrigin:
    process.env.AT_OAUTH_RESOURCE_SERVER_ORIGIN || "http://localhost:8080",
  atOauthClientMetadataTimeoutMs: Number.parseInt(
    process.env.AT_OAUTH_CLIENT_METADATA_TIMEOUT_MS || "6000",
    10
  ),
  atOauthClientMetadataMaxAttempts: Number.parseInt(
    process.env.AT_OAUTH_CLIENT_METADATA_MAX_ATTEMPTS || "4",
    10
  ),
  atOauthExternalDiscoveryTimeoutMs: Number.parseInt(
    process.env.AT_OAUTH_EXTERNAL_DISCOVERY_TIMEOUT_MS || "6000",
    10
  ),
  atOauthExternalDiscoveryMaxAttempts: Number.parseInt(
    process.env.AT_OAUTH_EXTERNAL_DISCOVERY_MAX_ATTEMPTS || "4",
    10
  ),
  atOauthAllowLocalhostHttpDiscovery: process.env.AT_OAUTH_ALLOW_LOCALHOST_HTTP_DISCOVERY === "true",
  atOauthBackendIntrospectionTimeoutMs: Number.parseInt(
    process.env.AT_OAUTH_BACKEND_INTROSPECTION_TIMEOUT_MS || "3000",
    10
  ),
  atOauthBackendIntrospectionMaxAttempts: Number.parseInt(
    process.env.AT_OAUTH_BACKEND_INTROSPECTION_MAX_ATTEMPTS || "3",
    10
  ),

  // Phase 7: durable write-result correlation settings
  atWriteResultTtlSec: Number.parseInt(process.env.AT_WRITE_RESULT_TTL_SEC || "120", 10),
  atWriteResultKeyPrefix: process.env.AT_WRITE_RESULT_KEY_PREFIX || "at:write-result",
  atWriteResultChannelPrefix: process.env.AT_WRITE_RESULT_CHANNEL_PREFIX || "at:write-result:ch",

  // Local fixture mode — for development / integration testing ONLY.
  // When true: uses LocalAtPasswordVerifier (no ActivityPods auth call) and
  // LocalAtSigningService (secp256k1 signing from Redis-stored fixture keys).
  // NEVER set in production.  Requires provision-test-fixture.ts to have been run.
  atLocalFixture: process.env.AT_LOCAL_FIXTURE === "true",

  identityWarmIntervalMs: Number.parseInt(process.env.IDENTITY_WARM_INTERVAL_MS || "30000", 10),
  identityWarmBatchLimit: Number.parseInt(process.env.IDENTITY_WARM_BATCH_LIMIT || "100", 10),
  externalAtSessionTtlSeconds: Number.parseInt(
    process.env.EXTERNAL_AT_SESSION_TTL_SECONDS || `${60 * 60 * 12}`,
    10
  ),
  externalPdsTimeoutMs: Number.parseInt(process.env.EXTERNAL_PDS_TIMEOUT_MS || "8000", 10),
  externalPdsMaxAttempts: Number.parseInt(process.env.EXTERNAL_PDS_MAX_ATTEMPTS || "5", 10),
  atOauthRouteRateLimits: parseOAuthRouteRateLimitsFromEnv(process.env),
  protocolBridgeConsumerGroupId:
    process.env.PROTOCOL_BRIDGE_CONSUMER_GROUP_ID || "fedify-sidecar-protocol-bridge",
  protocolBridgeApSourceTopic:
    process.env.PROTOCOL_BRIDGE_AP_SOURCE_TOPIC ||
    process.env.STREAM1_TOPIC ||
    "ap.stream1.local-public.v1",
  protocolBridgeAtCommitTopic:
    process.env.PROTOCOL_BRIDGE_AT_COMMIT_TOPIC || "at.commit.v1",
  protocolBridgeAtVerifiedIngressTopic:
    process.env.PROTOCOL_BRIDGE_AT_VERIFIED_INGRESS_TOPIC || "at.ingress.v1",
  protocolBridgeApIngressTopic:
    process.env.PROTOCOL_BRIDGE_AP_INGRESS_TOPIC || "ap.atproto-ingress.v1",
  atFirehoseConsumerGroupId:
    process.env.AT_FIREHOSE_CONSUMER_GROUP_ID || "fedify-sidecar-at-firehose",
  atFirehoseCursorMaxEvents: Number.parseInt(
    process.env.AT_FIREHOSE_CURSOR_MAX_EVENTS || "10000",
    10,
  ),
  atExternalFirehoseConsumerGroupId:
    process.env.AT_EXTERNAL_FIREHOSE_CONSUMER_GROUP_ID || "fedify-sidecar-at-firehose-external",
  atExternalFirehoseRawTopic:
    process.env.AT_EXTERNAL_FIREHOSE_RAW_TOPIC || "at.firehose.raw.v1",
  enableAtExternalFirehose: process.env.ENABLE_AT_EXTERNAL_FIREHOSE === "true",
  deploymentSize,
  inboundConcurrency: Number.parseInt(
    process.env.INBOUND_CONCURRENCY || `${selectedSizeDefaults.inboundConcurrency}`,
    10,
  ),
  outboundConcurrency: Number.parseInt(
    process.env.OUTBOUND_CONCURRENCY || `${selectedSizeDefaults.outboundConcurrency}`,
    10,
  ),
  maxConcurrentPerDomain: Number.parseInt(
    process.env.MAX_CONCURRENT_PER_DOMAIN || `${selectedSizeDefaults.maxConcurrentPerDomain}`,
    10,
  ),
  wsSubscribeReposMaxConnections: Number.parseInt(
    process.env.AT_SUBSCRIBE_REPOS_MAX_CONNECTIONS || `${selectedSizeDefaults.wsMaxConnections}`,
    10,
  ),
  wsSubscribeReposIdleTimeoutMs: Number.parseInt(
    process.env.AT_SUBSCRIBE_REPOS_IDLE_TIMEOUT_MS || `${selectedSizeDefaults.wsIdleTimeoutMs}`,
    10,
  ),
  wsSubscribeReposHeartbeatIntervalMs: Number.parseInt(
    process.env.AT_SUBSCRIBE_REPOS_HEARTBEAT_INTERVAL_MS || `${selectedSizeDefaults.wsHeartbeatIntervalMs}`,
    10,
  ),
  enableAdaptiveScaling: process.env.ENABLE_ADAPTIVE_SCALING === "true",
  adaptiveScalingIntervalMs: Number.parseInt(
    process.env.ADAPTIVE_SCALING_INTERVAL_MS || "10000",
    10,
  ),
  adaptiveScaleStep: Number.parseInt(process.env.ADAPTIVE_SCALE_STEP || "4", 10),
  adaptiveInboundLagHigh: Number.parseInt(process.env.ADAPTIVE_INBOUND_LAG_HIGH || "400", 10),
  adaptiveInboundLagLow: Number.parseInt(process.env.ADAPTIVE_INBOUND_LAG_LOW || "40", 10),
  adaptiveOutboundLagHigh: Number.parseInt(process.env.ADAPTIVE_OUTBOUND_LAG_HIGH || "1000", 10),
  adaptiveOutboundLagLow: Number.parseInt(process.env.ADAPTIVE_OUTBOUND_LAG_LOW || "100", 10),
  adaptiveInboundConcurrencyMin: Number.parseInt(
    process.env.ADAPTIVE_INBOUND_CONCURRENCY_MIN || `${Math.max(1, Math.floor(selectedSizeDefaults.inboundConcurrency / 2))}`,
    10,
  ),
  adaptiveInboundConcurrencyMax: Number.parseInt(
    process.env.ADAPTIVE_INBOUND_CONCURRENCY_MAX || `${selectedSizeDefaults.inboundConcurrency * 2}`,
    10,
  ),
  adaptiveOutboundConcurrencyMin: Number.parseInt(
    process.env.ADAPTIVE_OUTBOUND_CONCURRENCY_MIN || `${Math.max(1, Math.floor(selectedSizeDefaults.outboundConcurrency / 2))}`,
    10,
  ),
  adaptiveOutboundConcurrencyMax: Number.parseInt(
    process.env.ADAPTIVE_OUTBOUND_CONCURRENCY_MAX || `${selectedSizeDefaults.outboundConcurrency * 2}`,
    10,
  ),
  adaptiveMaxConcurrentPerDomainMin: Number.parseInt(
    process.env.ADAPTIVE_MAX_CONCURRENT_PER_DOMAIN_MIN || `${Math.max(1, Math.floor(selectedSizeDefaults.maxConcurrentPerDomain / 2))}`,
    10,
  ),
  adaptiveMaxConcurrentPerDomainMax: Number.parseInt(
    process.env.ADAPTIVE_MAX_CONCURRENT_PER_DOMAIN_MAX || `${selectedSizeDefaults.maxConcurrentPerDomain * 2}`,
    10,
  ),
  protocolBridgeLedgerTtlSec: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_LEDGER_TTL_SEC || `${60 * 60 * 24 * 14}`,
    10,
  ),
  protocolBridgeIngressTimeoutMs: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_INGRESS_TIMEOUT_MS || "10000",
    10,
  ),
  protocolBridgeOutboundResolutionTimeoutMs: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_OUTBOUND_RESOLUTION_TIMEOUT_MS || "10000",
    10,
  ),
  protocolBridgeActivityResolutionTimeoutMs: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_ACTIVITY_RESOLUTION_TIMEOUT_MS || "10000",
    10,
  ),
  protocolBridgeProfileMediaTimeoutMs: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_PROFILE_MEDIA_TIMEOUT_MS || "10000",
    10,
  ),
  protocolBridgeProfileMediaMaxBytes: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_PROFILE_MEDIA_MAX_BYTES || `${5 * 1024 * 1024}`,
    10,
  ),
  protocolBridgeAttachmentMediaTimeoutMs: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_ATTACHMENT_MEDIA_TIMEOUT_MS || "20000",
    10,
  ),
  protocolBridgeAttachmentMediaMaxBytes: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_ATTACHMENT_MEDIA_MAX_BYTES || `${50 * 1024 * 1024}`,
    10,
  ),
  protocolBridgeProfileMediaTtlSec: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_PROFILE_MEDIA_TTL_SEC || `${60 * 60 * 24}`,
    10,
  ),
  protocolBridgePostMediaTtlSec: Number.parseInt(
    process.env.PROTOCOL_BRIDGE_POST_MEDIA_TTL_SEC || `${60 * 60 * 24}`,
    10,
  ),
  protocolBridgeApNoteLinkPreviewMode: normalizeActivityPubNoteLinkPreviewMode(
    process.env.PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_MODE,
  ),
  protocolBridgeApNoteLinkPreviewRichDomains: normalizeActivityPubDomainRuleList(
    process.env.PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_RICH_DOMAINS,
  ),
  protocolBridgeApNoteLinkPreviewDisabledDomains: normalizeActivityPubDomainRuleList(
    process.env.PROTOCOL_BRIDGE_AP_NOTE_LINK_PREVIEW_DISABLED_DOMAINS,
  ),
};

// ============================================================================
// Global State
// ============================================================================

let queue: RedisStreamsQueue | null = null;
let outboundWorker: OutboundWorker | null = null;
let inboundWorker: InboundWorker | null = null;
let opensearchIndexer: ReturnType<typeof createOpenSearchIndexer> | null = null;
let atRedisClient: InstanceType<typeof Redis> | null = null;
let writeResultStore: AtWriteResultStore | null = null;
let identityWarmupService: IdentityWarmupService | null = null;
let atEventPublisher: RedpandaEventPublisher | null = null;
let atFirehoseRuntime: AtFirehoseRuntime | null = null;
let protocolBridgeRuntime: ProtocolBridgeRuntime | null = null;
let isShuttingDown = false;
let adaptiveScalingTimer: ReturnType<typeof setInterval> | null = null;

type ScaleDirection = "up" | "down" | "hold";

const adaptiveScalingState: {
  lastTickEpochMs: number;
  ticksTotal: number;
  errorsTotal: number;
  changesTotal: number;
  inboundLag: number;
  outboundLag: number;
  inboundDirection: ScaleDirection;
  outboundDirection: ScaleDirection;
  inboundConcurrencyCurrent: number;
  outboundConcurrencyCurrent: number;
  outboundPerDomainCurrent: number;
} = {
  lastTickEpochMs: 0,
  ticksTotal: 0,
  errorsTotal: 0,
  changesTotal: 0,
  inboundLag: 0,
  outboundLag: 0,
  inboundDirection: "hold",
  outboundDirection: "hold",
  inboundConcurrencyCurrent: 0,
  outboundConcurrencyCurrent: 0,
  outboundPerDomainCurrent: 0,
};

// ============================================================================
// Main Application
// ============================================================================

async function main() {
  logger.info("Starting Fedify Sidecar for ActivityPods", {
    version: config.version,
    nodeEnv: config.nodeEnv,
  });

  const activityPubOutboundDeliveryPolicy = {
    defaultNoteLinkPreviewMode: config.protocolBridgeApNoteLinkPreviewMode,
    richNoteLinkPreviewDomains: config.protocolBridgeApNoteLinkPreviewRichDomains,
    disabledNoteLinkPreviewDomains: config.protocolBridgeApNoteLinkPreviewDisabledDomains,
  } as const;

  const clampInt = (value: number, min: number, max: number): number => {
    return Math.max(min, Math.min(max, Math.floor(value)));
  };

  if (config.enableXrpcServer && !config.atLocalFixture) {
    if (!process.env.ACTIVITYPODS_URL) {
      throw new Error("ENABLE_XRPC_SERVER requires ACTIVITYPODS_URL when AT_LOCAL_FIXTURE is false");
    }
    if (!process.env.ACTIVITYPODS_TOKEN) {
      throw new Error("ENABLE_XRPC_SERVER requires ACTIVITYPODS_TOKEN when AT_LOCAL_FIXTURE is false");
    }
    if (!process.env.EXTERNAL_AT_SESSION_KEY_HEX) {
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

  const resolvedProviderProfile: ProviderProfile = (
    config.providerProfile === "ap-core" ||
    config.providerProfile === "ap-scale" ||
    config.providerProfile === "dual-protocol-standard"
  )
    ? config.providerProfile
    : inferProviderProfile(config.enableXrpcServer);

  const resolvedAtprotoEnabled = config.providerAtprotoEnabledRaw === undefined
    ? config.enableXrpcServer
    : config.providerAtprotoEnabledRaw === "true";

  const providerCapabilitiesDocument = buildProviderCapabilities({
    providerId: config.providerId,
    providerDisplayName: config.providerDisplayName,
    providerRegion: config.providerRegion,
    profile: resolvedProviderProfile,
    plan: config.providerPlan,
    enableInboundWorker: config.enableInboundWorker,
    enableOutboundWorker: config.enableOutboundWorker,
    enableOpenSearchIndexer: config.enableOpenSearchIndexer,
    enableXrpcServer: config.enableXrpcServer,
    enableMrf: process.env.ENABLE_MRF !== "false",
    atprotoEnabled: resolvedAtprotoEnabled,
    firehoseRetentionDays: Number.parseInt(process.env.PROVIDER_FIREHOSE_RETENTION_DAYS || "30", 10),
    includeAtDisabledEntries: true,
  });

  if (config.enableProviderCapabilitiesValidation) {
    const validation = validateProviderCapabilitiesConfig(providerCapabilitiesDocument, {
      profile: resolvedProviderProfile,
      hasRedisUrl: Boolean(process.env.REDIS_URL),
      hasRedpandaBrokers: Boolean(process.env.REDPANDA_BROKERS),
      hasSigningEndpoint: Boolean(process.env.ACTIVITYPODS_SIGNING_API_URL),
      hasSigningToken: Boolean(process.env.ACTIVITYPODS_TOKEN),
      hasOpenSearchUrl: Boolean(process.env.OPENSEARCH_URL),
      enableMrf: process.env.ENABLE_MRF !== "false",
    });

    for (const issue of validation.issues) {
      const level = issue.severity === "fatal" ? "error" : "warn";
      logger[level]({
        ruleId: issue.ruleId,
        code: issue.code,
        details: issue.details,
      }, issue.message);
    }

    if (!validation.ok) {
      throw new Error("Provider capabilities validation failed; refusing startup");
    }
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
    // Initialize Redis Streams queue
    const queueConfig = createQueueConfig();
    queue = new RedisStreamsQueue(queueConfig);
    await queue.connect();
    logger.info("Redis Streams queue connected");

    // Initialize Signing client
    const signingClient = createSigningClient();
    logger.info("Signing client initialized");

    // Initialize RedPanda producer only when worker/indexer features need it.
    const redpandaRequired =
      config.enableOpenSearchIndexer ||
      config.enableOutboundWorker ||
      config.enableInboundWorker;

    let redpanda: any = null;
    if (redpandaRequired) {
      redpanda = createRedPandaProducer();
      await redpanda.connect();
      logger.info("RedPanda producer connected");
    } else {
      logger.info("RedPanda producer skipped (workers/indexer disabled)");
    }

    // Initialize OpenSearch indexer
    if (config.enableOpenSearchIndexer) {
      opensearchIndexer = createOpenSearchIndexer();
      await opensearchIndexer.initialize();
      opensearchIndexer.start().catch(err => {
        logger.error("OpenSearch indexer error", { error: err.message });
      });
      logger.info("OpenSearch indexer started");
    }

    // Initialize outbound worker
    if (config.enableOutboundWorker) {
      outboundWorker = createOutboundWorker(queue, signingClient, redpanda, {
        concurrency: config.outboundConcurrency,
        maxConcurrentPerDomain: config.maxConcurrentPerDomain,
        capabilityGate: (capabilityId) => evaluateCapabilityGate(providerCapabilitiesDocument, capabilityId),
      });
      outboundWorker.start().catch(err => {
        logger.error("Outbound worker error", { error: err.message });
      });
      logger.info("Outbound worker started");
    }

    // Initialize inbound worker
    if (config.enableInboundWorker) {
      inboundWorker = createInboundWorker(queue, redpanda, {
        concurrency: config.inboundConcurrency,
        capabilityGate: (capabilityId) => evaluateCapabilityGate(providerCapabilitiesDocument, capabilityId),
      });
      inboundWorker.start().catch(err => {
        logger.error("Inbound worker error", { error: err.message });
      });
      logger.info("Inbound worker started");
    }

    if (config.enableAdaptiveScaling) {
      adaptiveScalingTimer = setInterval(() => {
        if (isShuttingDown || !queue) {
          return;
        }

        adaptiveScalingState.lastTickEpochMs = Date.now();

        Promise.all([
          queue.getPendingCount("inbound"),
          queue.getPendingCount("outbound"),
        ])
          .then(([inboundLag, outboundLag]) => {
            adaptiveScalingState.ticksTotal += 1;
            adaptiveScalingState.inboundLag = inboundLag;
            adaptiveScalingState.outboundLag = outboundLag;

            if (inboundWorker) {
              const inboundCurrent = inboundWorker.getConcurrency();
              let inboundTarget = inboundCurrent;
              let inboundDirection: ScaleDirection = "hold";

              if (inboundLag >= config.adaptiveInboundLagHigh) {
                inboundTarget = clampInt(
                  inboundCurrent + config.adaptiveScaleStep,
                  config.adaptiveInboundConcurrencyMin,
                  config.adaptiveInboundConcurrencyMax,
                );
                inboundDirection = inboundTarget > inboundCurrent ? "up" : "hold";
              } else if (inboundLag <= config.adaptiveInboundLagLow) {
                inboundTarget = clampInt(
                  inboundCurrent - config.adaptiveScaleStep,
                  config.adaptiveInboundConcurrencyMin,
                  config.adaptiveInboundConcurrencyMax,
                );
                inboundDirection = inboundTarget < inboundCurrent ? "down" : "hold";
              }

              if (inboundTarget !== inboundCurrent) {
                adaptiveScalingState.changesTotal += 1;
              }

              inboundWorker.setConcurrency(inboundTarget);
              adaptiveScalingState.inboundConcurrencyCurrent = inboundWorker.getConcurrency();
              adaptiveScalingState.inboundDirection = inboundDirection;
            }

            if (outboundWorker) {
              const outboundCurrent = outboundWorker.getConcurrency();
              const perDomainCurrent = outboundWorker.getMaxConcurrentPerDomain();
              let outboundTarget = outboundCurrent;
              let perDomainTarget = perDomainCurrent;
              let outboundDirection: ScaleDirection = "hold";

              if (outboundLag >= config.adaptiveOutboundLagHigh) {
                outboundTarget = clampInt(
                  outboundCurrent + config.adaptiveScaleStep,
                  config.adaptiveOutboundConcurrencyMin,
                  config.adaptiveOutboundConcurrencyMax,
                );
                perDomainTarget = clampInt(
                  perDomainCurrent + 1,
                  config.adaptiveMaxConcurrentPerDomainMin,
                  config.adaptiveMaxConcurrentPerDomainMax,
                );
                outboundDirection =
                  outboundTarget > outboundCurrent || perDomainTarget > perDomainCurrent
                    ? "up"
                    : "hold";
              } else if (outboundLag <= config.adaptiveOutboundLagLow) {
                outboundTarget = clampInt(
                  outboundCurrent - config.adaptiveScaleStep,
                  config.adaptiveOutboundConcurrencyMin,
                  config.adaptiveOutboundConcurrencyMax,
                );
                perDomainTarget = clampInt(
                  perDomainCurrent - 1,
                  config.adaptiveMaxConcurrentPerDomainMin,
                  config.adaptiveMaxConcurrentPerDomainMax,
                );
                outboundDirection =
                  outboundTarget < outboundCurrent || perDomainTarget < perDomainCurrent
                    ? "down"
                    : "hold";
              }

              if (outboundTarget !== outboundCurrent || perDomainTarget !== perDomainCurrent) {
                adaptiveScalingState.changesTotal += 1;
              }

              outboundWorker.setConcurrency(outboundTarget);
              outboundWorker.setMaxConcurrentPerDomain(perDomainTarget);
              adaptiveScalingState.outboundConcurrencyCurrent = outboundWorker.getConcurrency();
              adaptiveScalingState.outboundPerDomainCurrent =
                outboundWorker.getMaxConcurrentPerDomain();
              adaptiveScalingState.outboundDirection = outboundDirection;
            }
          })
          .catch((err: any) => {
            adaptiveScalingState.errorsTotal += 1;
            logger.warn("Adaptive scaling tick failed", {
              error: err?.message || String(err),
            });
          });
      }, config.adaptiveScalingIntervalMs);

      adaptiveScalingTimer.unref();
      logger.info("Adaptive scaling enabled", {
        intervalMs: config.adaptiveScalingIntervalMs,
        step: config.adaptiveScaleStep,
        inboundLagLow: config.adaptiveInboundLagLow,
        inboundLagHigh: config.adaptiveInboundLagHigh,
        outboundLagLow: config.adaptiveOutboundLagLow,
        outboundLagHigh: config.adaptiveOutboundLagHigh,
        inboundConcurrencyMin: config.adaptiveInboundConcurrencyMin,
        inboundConcurrencyMax: config.adaptiveInboundConcurrencyMax,
        outboundConcurrencyMin: config.adaptiveOutboundConcurrencyMin,
        outboundConcurrencyMax: config.adaptiveOutboundConcurrencyMax,
        maxConcurrentPerDomainMin: config.adaptiveMaxConcurrentPerDomainMin,
        maxConcurrentPerDomainMax: config.adaptiveMaxConcurrentPerDomainMax,
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
      };
    });

    // Readiness check endpoint
    app.get("/ready", async () => {
      if (!queue) {
        return { status: "not_ready", reason: "Queue not initialized" };
      }
      
      const outboundPending = await queue.getPendingCount("outbound");
      const inboundPending = await queue.getPendingCount("inbound");
      
      return {
        status: "ready",
        queues: {
          outbound: { pending: outboundPending },
          inbound: { pending: inboundPending },
        },
        workers: {
          outbound: config.enableOutboundWorker,
          inbound: config.enableInboundWorker,
          opensearch: config.enableOpenSearchIndexer,
        },
      };
    });

    // Metrics endpoint (Prometheus format)
    app.get("/metrics", async () => {
      if (!queue) {
        return "# Queue not initialized\n";
      }
      
      const outboundPending = await queue.getPendingCount("outbound");
      const inboundPending = await queue.getPendingCount("inbound");
      const outboundLength = await queue.getStreamLength("outbound");
      const inboundLength = await queue.getStreamLength("inbound");
      const inboundConcurrencyCurrent = inboundWorker ? inboundWorker.getConcurrency() : 0;
      const outboundConcurrencyCurrent = outboundWorker ? outboundWorker.getConcurrency() : 0;
      const outboundPerDomainCurrent = outboundWorker
        ? outboundWorker.getMaxConcurrentPerDomain()
        : 0;
      const inboundDirectionUp = adaptiveScalingState.inboundDirection === "up" ? 1 : 0;
      const inboundDirectionDown = adaptiveScalingState.inboundDirection === "down" ? 1 : 0;
      const outboundDirectionUp = adaptiveScalingState.outboundDirection === "up" ? 1 : 0;
      const outboundDirectionDown = adaptiveScalingState.outboundDirection === "down" ? 1 : 0;
      
      return [
        `# HELP fedify_outbound_pending Number of pending outbound jobs`,
        `# TYPE fedify_outbound_pending gauge`,
        `fedify_outbound_pending ${outboundPending}`,
        `# HELP fedify_inbound_pending Number of pending inbound envelopes`,
        `# TYPE fedify_inbound_pending gauge`,
        `fedify_inbound_pending ${inboundPending}`,
        `# HELP fedify_outbound_stream_length Total outbound stream length`,
        `# TYPE fedify_outbound_stream_length gauge`,
        `fedify_outbound_stream_length ${outboundLength}`,
        `# HELP fedify_inbound_stream_length Total inbound stream length`,
        `# TYPE fedify_inbound_stream_length gauge`,
        `fedify_inbound_stream_length ${inboundLength}`,
        `# HELP fedify_uptime_seconds Uptime in seconds`,
        `# TYPE fedify_uptime_seconds gauge`,
        `fedify_uptime_seconds ${Math.floor(process.uptime())}`,
        `# HELP fedify_adaptive_scaling_enabled Adaptive scaling enabled flag`,
        `# TYPE fedify_adaptive_scaling_enabled gauge`,
        `fedify_adaptive_scaling_enabled ${config.enableAdaptiveScaling ? 1 : 0}`,
        `# HELP fedify_adaptive_scaling_ticks_total Total adaptive scaling ticks completed`,
        `# TYPE fedify_adaptive_scaling_ticks_total counter`,
        `fedify_adaptive_scaling_ticks_total ${adaptiveScalingState.ticksTotal}`,
        `# HELP fedify_adaptive_scaling_errors_total Total adaptive scaling tick errors`,
        `# TYPE fedify_adaptive_scaling_errors_total counter`,
        `fedify_adaptive_scaling_errors_total ${adaptiveScalingState.errorsTotal}`,
        `# HELP fedify_adaptive_scaling_changes_total Total adaptive scaling changes applied`,
        `# TYPE fedify_adaptive_scaling_changes_total counter`,
        `fedify_adaptive_scaling_changes_total ${adaptiveScalingState.changesTotal}`,
        `# HELP fedify_adaptive_scaling_last_tick_epoch_seconds Last adaptive scaling tick time (epoch seconds)`,
        `# TYPE fedify_adaptive_scaling_last_tick_epoch_seconds gauge`,
        `fedify_adaptive_scaling_last_tick_epoch_seconds ${
          adaptiveScalingState.lastTickEpochMs > 0
            ? Math.floor(adaptiveScalingState.lastTickEpochMs / 1000)
            : 0
        }`,
        `# HELP fedify_adaptive_inbound_lag Last inbound lag observed by autoscaler`,
        `# TYPE fedify_adaptive_inbound_lag gauge`,
        `fedify_adaptive_inbound_lag ${adaptiveScalingState.inboundLag}`,
        `# HELP fedify_adaptive_outbound_lag Last outbound lag observed by autoscaler`,
        `# TYPE fedify_adaptive_outbound_lag gauge`,
        `fedify_adaptive_outbound_lag ${adaptiveScalingState.outboundLag}`,
        `# HELP fedify_inbound_concurrency_current Current inbound worker concurrency`,
        `# TYPE fedify_inbound_concurrency_current gauge`,
        `fedify_inbound_concurrency_current ${inboundConcurrencyCurrent}`,
        `# HELP fedify_outbound_concurrency_current Current outbound worker concurrency`,
        `# TYPE fedify_outbound_concurrency_current gauge`,
        `fedify_outbound_concurrency_current ${outboundConcurrencyCurrent}`,
        `# HELP fedify_outbound_per_domain_concurrency_current Current outbound max concurrency per domain`,
        `# TYPE fedify_outbound_per_domain_concurrency_current gauge`,
        `fedify_outbound_per_domain_concurrency_current ${outboundPerDomainCurrent}`,
        `# HELP fedify_adaptive_inbound_direction_up Last inbound scaling direction was up`,
        `# TYPE fedify_adaptive_inbound_direction_up gauge`,
        `fedify_adaptive_inbound_direction_up ${inboundDirectionUp}`,
        `# HELP fedify_adaptive_inbound_direction_down Last inbound scaling direction was down`,
        `# TYPE fedify_adaptive_inbound_direction_down gauge`,
        `fedify_adaptive_inbound_direction_down ${inboundDirectionDown}`,
        `# HELP fedify_adaptive_outbound_direction_up Last outbound scaling direction was up`,
        `# TYPE fedify_adaptive_outbound_direction_up gauge`,
        `fedify_adaptive_outbound_direction_up ${outboundDirectionUp}`,
        `# HELP fedify_adaptive_outbound_direction_down Last outbound scaling direction was down`,
        `# TYPE fedify_adaptive_outbound_direction_down gauge`,
        `fedify_adaptive_outbound_direction_down ${outboundDirectionDown}`,
        ...renderOAuthSecurityMetricsLines(),
      ].join("\n") + "\n";
    });

    if (config.enableProviderCapabilitiesEndpoint) {
      app.get("/.well-known/provider-capabilities", async (request, reply) => {
        const rendered = renderCapabilitiesResponse(providerCapabilitiesDocument);
        const etag = `\"${rendered.etag}\"`;
        const ifNoneMatch = request.headers["if-none-match"];

        if (ifNoneMatch === etag) {
          reply.status(304).header("ETag", etag).send();
          return;
        }

        reply
          .header("Content-Type", "application/vnd.activitypods.provider-capabilities+json;version=1")
          .header("Cache-Control", "public, max-age=60")
          .header("ETag", etag)
          .send(rendered.body);
      });
    }

    // Shared inbox endpoint
    app.post("/inbox", async (request, reply) => {
      const gate = evaluateCapabilityGate(providerCapabilitiesDocument, "ap.federation.ingress");
      if (!gate.allowed) {
        reply.status(403).send({
          error: gate.reasonCode ?? "feature_disabled",
          message: gate.message ?? "AP ingress capability is disabled",
          capabilityId: gate.capabilityId,
          retryable: gate.retryable ?? false,
        });
        return;
      }

      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      
      const envelope = createInboundEnvelope({
        method: "POST",
        path: "/inbox",
        headers: normalizeHeaders(request.headers),
        body: request.body as string,
        remoteIp: request.ip,
      });

      await queue.enqueueInbound(envelope);
      
      reply.status(202).send({ accepted: true, envelopeId: envelope.envelopeId });
    });

    // Per-user inbox endpoint
    app.post("/users/:username/inbox", async (request, reply) => {
      const gate = evaluateCapabilityGate(providerCapabilitiesDocument, "ap.federation.ingress");
      if (!gate.allowed) {
        reply.status(403).send({
          error: gate.reasonCode ?? "feature_disabled",
          message: gate.message ?? "AP ingress capability is disabled",
          capabilityId: gate.capabilityId,
          retryable: gate.retryable ?? false,
        });
        return;
      }

      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      
      const { username } = request.params as { username: string };
      
      const envelope = createInboundEnvelope({
        method: "POST",
        path: `/users/${username}/inbox`,
        headers: normalizeHeaders(request.headers),
        body: request.body as string,
        remoteIp: request.ip,
      });

      await queue.enqueueInbound(envelope);
      
      reply.status(202).send({ accepted: true, envelopeId: envelope.envelopeId });
    });

    // Alternative inbox path format
    app.post("/:username/inbox", async (request, reply) => {
      const gate = evaluateCapabilityGate(providerCapabilitiesDocument, "ap.federation.ingress");
      if (!gate.allowed) {
        reply.status(403).send({
          error: gate.reasonCode ?? "feature_disabled",
          message: gate.message ?? "AP ingress capability is disabled",
          capabilityId: gate.capabilityId,
          retryable: gate.retryable ?? false,
        });
        return;
      }

      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      
      const { username } = request.params as { username: string };
      
      const envelope = createInboundEnvelope({
        method: "POST",
        path: `/${username}/inbox`,
        headers: normalizeHeaders(request.headers),
        body: request.body as string,
        remoteIp: request.ip,
      });

      await queue.enqueueInbound(envelope);
      
      reply.status(202).send({ accepted: true, envelopeId: envelope.envelopeId });
    });

    // Outbound webhook — receives delivery work from ActivityPods
    app.post("/webhook/outbox", async (request, reply) => {
      const gate = evaluateCapabilityGate(providerCapabilitiesDocument, "ap.federation.egress");
      if (!gate.allowed) {
        reply.status(403).send({
          error: gate.reasonCode ?? "feature_disabled",
          message: gate.message ?? "AP egress capability is disabled",
          capabilityId: gate.capabilityId,
          retryable: gate.retryable ?? false,
        });
        return;
      }

      const authHeader = (request.headers["authorization"] as string) || "";
      const [scheme, token] = authHeader.split(" ");
      if (scheme !== "Bearer" || token !== config.sidecarToken) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      // Parse JSON body (stored as string for signature verification)
      let body: any;
      try {
        body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
      } catch (err) {
        reply.status(400).send({ error: "Bad Request - Invalid JSON" });
        return;
      }

      if (!body?.actorUri || !body?.activity || !Array.isArray(body?.remoteTargets)) {
        reply.status(400).send({ error: "Bad Request" });
        return;
      }

      const normalizedMeta = body?.meta && typeof body.meta === "object"
        ? body.meta
        : undefined;

      if (!queue) {
        reply.status(503).send({ error: "Service unavailable" });
        return;
      }
      const bridgeHints = body?.bridge?.activityPubHints && typeof body.bridge.activityPubHints === "object"
        ? body.bridge.activityPubHints
        : undefined;
      let jobCount = 0;
      for (const target of body.remoteTargets) {
        if (!target.inboxUrl || !target.targetDomain) continue;
        const deliveryUrl = target.sharedInboxUrl || target.inboxUrl;
        const activityJson = JSON.stringify(
          applyActivityPubOutboundDeliveryPolicy(
            body.activity as Record<string, unknown>,
            String(target.targetDomain),
            bridgeHints,
            activityPubOutboundDeliveryPolicy,
          ),
        );
        const job: OutboundJob = {
          jobId: `${body.activityId}::${deliveryUrl}`,
          activityId: body.activityId,
          actorUri: body.actorUri,
          activity: activityJson,
          targetInbox: deliveryUrl,
          targetDomain: target.targetDomain,
          attempt: 0,
          maxAttempts: 10,
          notBeforeMs: 0,
          meta: normalizedMeta,
        };
        await queue.enqueueOutbound(job);
        jobCount++;
      }
      reply.status(202).send({ accepted: true, jobCount });
    });

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
        const atRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
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
          process.env.EXTERNAL_AT_SESSION_KEY_HEX ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          config.externalAtSessionTtlSeconds,
        );
        const externalWriteGateway = new ExternalWriteGateway(
          externalPdsClient,
          externalAtSessionStore,
          process.env.AT_OAUTH_CLIENT_ID ?? config.atOauthIssuer.replace(/\/$/, '') + '/oauth/atproto-sidecar.client.json',
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
                backendBaseUrl: process.env.ACTIVITYPODS_URL!,
                bearerToken: process.env.ACTIVITYPODS_TOKEN!,
                identityBindingRepository: identityRepo,
                repoRegistry,
                logger,
              });

          if (identityBindingSyncService) {
          logger.info("AT identity sync enabled", {
              backendBaseUrl: process.env.ACTIVITYPODS_URL,
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
                baseUrl: process.env.ACTIVITYPODS_URL ?? "http://localhost:3000",
                token:   process.env.ACTIVITYPODS_TOKEN ?? "",
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
          brokers: (process.env.REDPANDA_BROKERS || "localhost:9092")
            .split(",")
            .map((broker) => broker.trim())
            .filter(Boolean),
          clientId: `${process.env.REDPANDA_CLIENT_ID || "fedify-sidecar"}-events`,
          compression: (process.env.REDPANDA_COMPRESSION || "zstd") as
            | "none"
            | "gzip"
            | "snappy"
            | "lz4"
            | "zstd",
          connectionTimeoutMs: Number.parseInt(
            process.env.REDPANDA_CONNECTION_TIMEOUT || "10000",
            10,
          ),
          requestTimeoutMs: Number.parseInt(
            process.env.REDPANDA_REQUEST_TIMEOUT || "30000",
            10,
          ),
          source: "fedify-sidecar.at-native",
        });
        await atEventPublisher.connect();
        const eventPublisherAdapter: EventPublisher = atEventPublisher;

        atFirehoseRuntime = new AtFirehoseRuntime({
          config: {
            brokers: (process.env.REDPANDA_BROKERS || "localhost:9092")
              .split(",")
              .map((broker) => broker.trim())
              .filter(Boolean),
            clientId: process.env.REDPANDA_CLIENT_ID || "fedify-sidecar",
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
        await atFirehoseRuntime.start();

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
              process.env.AT_EXTERNAL_FIREHOSE_SOURCES,
            );
            const externalIngressBootstrap = buildAtExternalFirehoseBootstrap({
              runtimeConfig: {
                brokers: (process.env.REDPANDA_BROKERS || "localhost:9092")
                  .split(",")
                  .map((broker) => broker.trim())
                  .filter(Boolean),
                clientId: process.env.REDPANDA_CLIENT_ID || "fedify-sidecar",
                consumerGroupId: config.atExternalFirehoseConsumerGroupId,
                rawTopic: config.atExternalFirehoseRawTopic,
                sources: externalFirehoseSources,
              },
              redis: atRedis as any,
              eventPublisher: eventPublisherAdapter,
              repoRegistry,
              commitVerifier: null,
              logger: {
                info: (message, meta) => logger.info(meta || {}, message),
                warn: (message, meta) => logger.warn(meta || {}, message),
                error: (message, meta) => logger.error(meta || {}, message),
              },
              identityResolverOptions: {
                timeoutMs: config.externalPdsTimeoutMs,
                maxAttempts: config.externalPdsMaxAttempts,
              },
              syncRebuilderOptions: {
                fetchImpl: fetch,
                timeoutMs: config.externalPdsTimeoutMs,
                maxAttempts: config.externalPdsMaxAttempts,
              },
            });

            logger.warn(
              {
                enableAtExternalFirehose: true,
                sourceCount: externalIngressBootstrap.sources.length,
                rawTopic: config.atExternalFirehoseRawTopic,
                consumerGroupId: config.atExternalFirehoseConsumerGroupId,
                bootstrapStatus: externalIngressBootstrap.kind,
                bootstrapReason: externalIngressBootstrap.kind === "disabled"
                  ? externalIngressBootstrap.reason
                  : undefined,
              },
              externalIngressBootstrap.kind === "disabled"
                ? `External AT firehose intake requested but not started: ${externalIngressBootstrap.message}`
                : "External AT firehose intake bootstrap was prepared",
            );
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

        // ---- Projection worker ----
          const blobStore             = new RedisAtBlobStore(atRedis);
        const blobReferenceMapper   = new DefaultBlobReferenceMapper();
        const blobUploadService     = new DefaultAtBlobUploadService(blobStore, blobReferenceMapper);
        const profileMediaStore     = new RedisBridgeProfileMediaStore(atRedis, {
          ttlSeconds: config.protocolBridgeProfileMediaTtlSec,
        });
        const postMediaStore        = new RedisBridgePostMediaStore(atRedis, {
          ttlSeconds: config.protocolBridgePostMediaTtlSec,
        });
        const bridgeRasterImageClient = new ActivityPubBridgeProfileMediaClient({
          activityPodsBaseUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
          bearerToken: process.env.ACTIVITYPODS_TOKEN || "",
          timeoutMs: config.protocolBridgeProfileMediaTimeoutMs,
          maxMediaBytes: config.protocolBridgeProfileMediaMaxBytes,
        });
        const bridgeAttachmentMediaClient = new ActivityPubBridgeMediaClient({
          activityPodsBaseUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
          bearerToken: process.env.ACTIVITYPODS_TOKEN || "",
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
                      activityPodsBaseUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
                      bearerToken: process.env.ACTIVITYPODS_TOKEN || "",
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
                    activityPodsBaseUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
                    bearerToken: process.env.ACTIVITYPODS_TOKEN || "",
                    timeoutMs: config.protocolBridgeOutboundResolutionTimeoutMs,
                  }),
                  deliveryPolicy: activityPubOutboundDeliveryPolicy,
                },
              )
            : undefined;
          const bridgeApIngressForwarder = config.enableProtocolBridgeAtToAp
            ? new ActivityPubBridgeIngressClient({
                activityPodsBaseUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
                bearerToken: process.env.ACTIVITYPODS_TOKEN || "",
                timeoutMs: config.protocolBridgeIngressTimeoutMs,
              })
            : undefined;

          protocolBridgeRuntime = new ProtocolBridgeRuntime({
            config: {
              brokers: (process.env.REDPANDA_BROKERS || "localhost:9092")
                .split(",")
                .map((broker) => broker.trim())
                .filter(Boolean),
              clientId: process.env.REDPANDA_CLIENT_ID || "fedify-sidecar",
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
                )
              : undefined,
            apIngressForwarder: bridgeApIngressForwarder,
            logger: {
              info: (message, meta) => logger.info(meta || {}, message),
              warn: (message, meta) => logger.warn(meta || {}, message),
              error: (message, meta) => logger.error(meta || {}, message),
            },
          });
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

          if (process.env.ACTIVITYPODS_URL && process.env.ACTIVITYPODS_TOKEN) {
            const backendOauthTokenVerifier = new BackendIntrospectionTokenVerifier({
              introspectionUrl: `${process.env.ACTIVITYPODS_URL.replace(/\/$/, '')}/api/internal/oauth/introspect`,
              introspectionBearerToken: process.env.ACTIVITYPODS_TOKEN,
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
          capabilityGate: (capabilityId) => evaluateCapabilityGate(providerCapabilitiesDocument, capabilityId),
        });
        xrpcServerForWebSocket = xrpcServer;

        if (!config.atLocalFixture) {
          identityWarmupService = new IdentityWarmupService({
            backendBaseUrl: process.env.ACTIVITYPODS_URL!,
            bearerToken: process.env.ACTIVITYPODS_TOKEN!,
            identityBindingRepository: identityRepo,
            cursorStore: new RedisIdentityWarmCursorStore(atRedis),
            repoRegistry,
            logger,
            intervalMs: config.identityWarmIntervalMs,
            batchLimit: config.identityWarmBatchLimit,
          });
          identityWarmupService.start();

          logger.info("AT identity warmup enabled", {
            backendBaseUrl: process.env.ACTIVITYPODS_URL,
            intervalMs: config.identityWarmIntervalMs,
            batchLimit: config.identityWarmBatchLimit,
          });
        }

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
      attachSubscribeReposWebSocket(app, xrpcServerForWebSocket, {
        capabilityGate: (capabilityId) => evaluateCapabilityGate(providerCapabilitiesDocument, capabilityId),
        maxConnections: config.wsSubscribeReposMaxConnections,
        idleTimeoutMs: config.wsSubscribeReposIdleTimeoutMs,
        heartbeatIntervalMs: config.wsSubscribeReposHeartbeatIntervalMs,
      });
    }

    // Start HTTP server only after all HTTP and WebSocket routes are registered.
    await app.listen({ port: config.port, host: config.host });

    logger.info(`Fedify Sidecar listening on ${config.host}:${config.port}`);
    logger.info(`Metrics available at http://${config.host}:${config.port}/metrics`);
    logger.info("Configuration summary", {
      domain: config.domain,
      deploymentSize: config.deploymentSize,
      enableOutboundWorker: config.enableOutboundWorker,
      enableInboundWorker: config.enableInboundWorker,
      enableOpenSearchIndexer: config.enableOpenSearchIndexer,
      inboundConcurrency: config.inboundConcurrency,
      outboundConcurrency: config.outboundConcurrency,
      maxConcurrentPerDomain: config.maxConcurrentPerDomain,
      wsSubscribeReposMaxConnections: config.wsSubscribeReposMaxConnections,
      wsSubscribeReposIdleTimeoutMs: config.wsSubscribeReposIdleTimeoutMs,
      wsSubscribeReposHeartbeatIntervalMs: config.wsSubscribeReposHeartbeatIntervalMs,
      enableAdaptiveScaling: config.enableAdaptiveScaling,
      adaptiveScalingIntervalMs: config.adaptiveScalingIntervalMs,
    });

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
    if (adaptiveScalingTimer) {
      clearInterval(adaptiveScalingTimer);
      adaptiveScalingTimer = null;
    }

    // Stop workers first
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

    if (protocolBridgeRuntime) {
      await protocolBridgeRuntime.stop();
      protocolBridgeRuntime = null;
      logger.info("Protocol bridge runtime stopped");
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
