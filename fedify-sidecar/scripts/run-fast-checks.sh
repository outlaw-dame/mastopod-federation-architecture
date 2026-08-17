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
  src/adsp/tests/RemoteFixtureDurableObserver.test.ts \
  src/adsp/tests/RemoteFixtureHandoffClient.test.ts \
  src/adsp/tests/RemoteFixtureOutcomeReconciler.test.ts \
  src/adsp/tests/RemoteFixtureRunner.test.ts \
  src/adsp/tests/RemoteFixtureSettlement.test.ts \
  src/queue/tests/RedisStreamsQueue.test.ts \
  src/queue/tests/DelayedOutboundQueue.test.ts \
  src/delivery/tests/ApdmReplayHorizon.test.ts \
  src/delivery/tests/DurableHandoffIdempotency.test.ts \
  src/delivery/tests/OutboundDeliveryClaimRetention.test.ts \
  src/delivery/tests/OutboundNotBeforeScheduling.test.ts \
  src/delivery/tests/OutboxIntentWorker.test.ts \
  src/delivery/tests/RemoteSharedInboxCacheRetired.test.ts \
  src/security/tests/ActivityPubEgressPolicy.test.ts \
  src/security/tests/ActivityPubEgressPolicyPhase5Regression.test.ts \
  src/security/tests/ActivityPubPinnedDns.test.ts \
  src/at-adapter/external/ExternalAtSessionStore.test.ts \
  src/at-adapter/oauth/OAuthRefreshTokenStore.scalability.test.ts \
  src/atproto/repo/AtprotoRepoRegistry.scalability.test.ts \
  src/atproto/repo/AtprotoRepoRegistry.collection-index.test.ts \
  src/atproto/repo/AtprotoRepoRegistry.exec-errors.test.ts \
  src/protocol-bridge/identity/ObservedAtIdentityStore.scalability.test.ts \
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
  src/core-domain/identity/RedisIdentityBindingRepository.test.ts
