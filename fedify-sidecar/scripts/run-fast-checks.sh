#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SIDECAR_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)

cd "${SIDECAR_ROOT}"

npm exec -- tsc -p tsconfig.json --noEmit
npm exec -- vitest run \
  src/adsp/tests/ControlledActivityPubTarget.test.ts \
  src/adsp/tests/ControlledTargetFixtureClient.test.ts \
  src/adsp/tests/ControlledTargetSnapshotClient.test.ts \
  src/adsp/tests/P2W3EvidenceSummary.test.ts \
  src/adsp/tests/P2W3HostGatewayProxy.test.ts \
  src/adsp/tests/RemoteFixtureActivityPodsOrigin.test.ts \
  src/adsp/tests/RemoteFixtureRedPandaProof.test.ts \
  src/adsp/tests/RemoteFixtureCase.test.ts \
  src/adsp/tests/RemoteFixtureCli.test.ts \
  src/adsp/tests/RemoteFixtureDurableObserver.test.ts \
  src/adsp/tests/RemoteFixtureHandoffClient.test.ts \
  src/adsp/tests/RemoteFixtureLiveRuntime.test.ts \
  src/adsp/tests/RemoteFixtureOutcomeReconciler.test.ts \
  src/adsp/tests/RemoteFixtureRunner.test.ts \
  src/adsp/tests/RemoteFixtureSettlement.test.ts \
  src/queue/tests/RedisStreamsQueue.test.ts \
  src/queue/tests/RedisStreamPayloadCodec.test.ts \
  src/queue/tests/RedisStreamsQueueCompression.test.ts \
  src/queue/tests/DelayedOutboundQueue.test.ts \
  src/delivery/tests/ApdmReplayHorizon.test.ts \
  src/delivery/tests/DurableHandoffIdempotency.test.ts \
  src/delivery/tests/OutboundDeliveryClaimRetention.test.ts \
  src/delivery/tests/OutboundNotBeforeScheduling.test.ts \
  src/delivery/tests/OutboxIntentWorker.test.ts \
  src/delivery/tests/RemoteSharedInboxCacheRetired.test.ts \
  src/delivery/tests/StreamOriginAuthority.test.ts \
  src/delivery/tests/RedisQueueBackpressureAcknowledgment.test.ts \
  src/security/tests/ActivityPubEgressPolicy.test.ts \
  src/security/tests/ActivityPubEgressPolicyPhase5Regression.test.ts \
  src/security/tests/ActivityPubPinnedDns.test.ts \
  src/at-adapter/external/ExternalAtSessionStore.test.ts \
  src/at-adapter/oauth/OAuthRefreshTokenStore.scalability.test.ts \
  src/atproto/repo/AtprotoRepoRegistry.scalability.test.ts \
  src/atproto/repo/AtprotoRepoRegistry.collection-index.test.ts \
  src/atproto/repo/AtprotoRepoRegistry.exec-errors.test.ts \
  src/at-adapter/repo/AtprotoRepositoryReadiness.test.ts \
  src/protocol-bridge/identity/ObservedAtIdentityStore.scalability.test.ts \
  src/protocol-bridge/notifications/tests/CanonicalNotificationConsumerReliability.test.ts \
  src/protocol-bridge/notifications/tests/CanonicalNotificationConsumerHttpGate.test.ts \
  src/at-adapter/tests/RedisAtFirehoseSourceFence.test.ts \
  src/at-adapter/tests/AtFirehoseFenceLoadBaseline.test.ts \
  src/at-adapter/tests/AtExternalFirehoseLargePayload.test.ts \
  src/at-adapter/tests/RedisExternalAtModeGate.test.ts \
  src/at-adapter/tests/AtIngressBoundedDedupe.test.ts \
  src/at-adapter/tests/AtFirehoseMultiWorkerOwnership.test.ts \
  src/at-adapter/tests/AtFirehoseWebSocketSafety.test.ts \
  src/at-adapter/tests/AtFirehoseCursorFailure.test.ts \
  src/at-adapter/tests/AtExternalFirehoseBootstrap.test.ts \
  src/at-adapter/tests/AtIngressRuntime.test.ts \
  src/at-adapter/tests/AtExternalIngestionPolicy.test.ts \
  src/at-adapter/tests/AtJetstreamSecurity.test.ts \
  src/at-adapter/tests/AtJetstreamWebSocketBackpressure.test.ts \
  src/streams/tests/RedpandaOptionalTopicGovernance.test.ts \
  src/at-adapter/tests/AtIngressWebhookForwarder.test.ts \
  src/admin/mrf/routes.registry.test.ts \
  src/fep3ab2/tests/Fep3ab2ClientIpBoundary.test.ts \
  src/federation/FedifyKvAdapter.test.ts \
  src/federation/fep8fcf/FedifyFollowersSyncSender.test.ts \
  src/federation/fep8fcf/FollowersSyncService.singleflight.test.ts \
  src/federation/tests/FedifyFastifyBridge.test.ts \
  src/federation/tests/FedifyFederationAdapterOutbound.test.ts \
  src/federation/tests/Phase5OutboundProtocolMatrix.test.ts \
  src/delivery/tests/FederationRuntimeAdapterParity.test.ts \
  src/signing/tests/ActivityPubHttpSignatureGoldenVectors.test.ts \
  src/core-domain/identity/RedisIdentityBindingRepository.test.ts \
  src/interop/ap/FixtureMetadata.test.ts \
  src/interop/ap/FixtureBoundaryRunner.test.ts \
  src/interop/ap/FixtureCorpus.test.ts
