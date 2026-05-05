import { createHash } from "node:crypto";
import {
  CapabilityEntry,
  ProviderCapabilitiesBuildInput,
  ProviderCapabilitiesDocument,
  ProviderProfile,
  TopicEventEntry,
} from "./types.js";

const SUPPORTED_PROFILES: ProviderProfile[] = ["ap-core", "ap-scale", "dual-protocol-standard"];

function enabledCapability(
  id: string,
  dependencies: string[],
  limits: Record<string, string | number | boolean>,
): CapabilityEntry {
  return {
    id,
    version: "1.0.0",
    status: "enabled",
    dependencies,
    limits,
  };
}

function disabledAtCapability(id: string, reason: string): CapabilityEntry {
  return {
    id,
    version: "1.0.0",
    status: "disabled",
    dependencies: ["protocol.atproto"],
    limits: {},
    disabledReason: reason,
  };
}

export function inferProviderProfile(enableXrpcServer: boolean): ProviderProfile {
  return enableXrpcServer ? "dual-protocol-standard" : "ap-scale";
}

export function buildProviderCapabilities(
  input: ProviderCapabilitiesBuildInput,
): ProviderCapabilitiesDocument {
  const caps: CapabilityEntry[] = [];

  if (input.enableAccountProvisioning !== false) {
    caps.push(enabledCapability("provider.account.provisioning", [], {
      approvedAppsRequired: true,
      requiresUserVerification: true,
      maxAccountsPerAppPerDay: input.accountProvisioningMaxAccountsPerAppPerDay
        ?? (input.profile === "dual-protocol-standard" ? 250 : 100),
      supportedProtocolSet: input.atprotoEnabled
        ? "solid,activitypub,atproto"
        : "solid,activitypub",
    }));
  }

  if (input.enableInboundWorker) {
    caps.push(enabledCapability("ap.federation.ingress", [], {
      maxPayloadBytes: 1048576,
      requestsPerMinute: input.profile === "ap-core" ? 1200 : 3000,
    }));
  }

  if (input.enableOutboundWorker) {
    caps.push(enabledCapability("ap.federation.egress", ["ap.signing.batch", "ap.queue.delivery"], {
      maxConcurrentPerDomain: input.profile === "ap-core" ? 4 : 8,
      maxAttempts: 10,
    }));
    caps.push(enabledCapability("ap.signing.batch", [], {
      batchSize: input.profile === "ap-core" ? 100 : 200,
      timeoutMs: 5000,
    }));
    caps.push(enabledCapability("ap.queue.delivery", [], {
      dlqEnabled: true,
      idempotencyTtlHours: 168,
    }));
  }

  if (input.profile !== "ap-core") {
    caps.push(enabledCapability("ap.streams", [], {
      retentionDays: input.firehoseRetentionDays,
      replayWindowHours: 72,
    }));
    caps.push(enabledCapability("ap.firehose", ["ap.streams"], {
      retentionDays: input.firehoseRetentionDays,
      replayWindowHours: 72,
    }));

    // Real-time feed subscriptions (SSE + WebSocket fan-out).
    // This capability is always enabled for non-ap-core profiles because the
    // DurableStreamSubscriptionService runs in-process; the unified stream is
    // available even without Kafka.
    caps.push(enabledCapability("ap.feeds.realtime", [], {
      maxSseConnections: 50,
      maxWsConnections: 25,
      maxStreamsPerConnection: 4,
      transports: "sse,websocket",
      streamingControlDiscovery: "actor.endpoints.streamingControl",
      browserAuthMode: "session+ticket-cookie",
    }));

    if (input.enableOpenSearchIndexer) {
      caps.push(enabledCapability("ap.search.opensearch", ["ap.firehose"], {
        indexRefreshSeconds: 1,
        queryTimeoutMs: 3000,
      }));
    }

    if (input.enableMrf) {
      caps.push(enabledCapability("ap.mrf", [], { policyModules: 16 }));
    }

    if (input.enableMediaPipeline) {
      caps.push(enabledCapability("ap.media.pipeline", ["ap.streams"], {
        ingestMode: "activitypods-local-resolver",
        assetEventTopic: "media.asset.created.v1",
      }));
    }
  }

  if (input.atprotoEnabled) {
    caps.push(enabledCapability("at.identity.binding", ["protocol.atproto"], { maxBindingsPerTenant: 100000 }));
    caps.push(enabledCapability("at.xrpc.server", ["protocol.atproto"], { requestsPerMinute: 1200 }));
    caps.push(enabledCapability("at.xrpc.repo", ["protocol.atproto", "at.identity.binding"], { maxWritesPerMinute: 600 }));
  } else if (input.includeAtDisabledEntries) {
    caps.push(disabledAtCapability("at.identity.binding", "profile_not_active"));
    caps.push(disabledAtCapability("at.xrpc.server", "profile_not_active"));
    caps.push(disabledAtCapability("at.xrpc.repo", "profile_not_active"));
  }

  return {
    schemaVersion: "1.0.0",
    provider: {
      id: input.providerId,
      displayName: input.providerDisplayName,
      region: input.providerRegion,
    },
    profiles: {
      active: [input.profile],
      supported: SUPPORTED_PROFILES,
    },
    protocols: {
      activitypub: {
        enabled: true,
        version: "1.0",
        status: "enabled",
      },
      atproto: input.atprotoEnabled
        ? { enabled: true, version: "1.0", status: "enabled" }
        : { enabled: false, status: "disabled", disabledReason: "provider_policy" },
    },
    capabilities: caps,
    entitlements: {
      plan: input.plan,
      effectiveAt: new Date().toISOString(),
      overrides: [],
    },
    degradation: {
      modes: [
        {
          when: "ap.search.opensearch.disabled",
          behavior: "feeds_limited",
          contractRef: "feed-limited-v1",
        },
        {
          when: "ap.streams.unavailable",
          behavior: "kafka_streams_degraded",
          contractRef: "stream-degraded-v1",
        },
        {
          when: "ap.feeds.realtime.disabled",
          behavior: "realtime_stream_unavailable",
          contractRef: "realtime-disabled-v1",
        },
        {
          when: "ap.signing.batch.unavailable",
          behavior: "federation_egress_paused",
          contractRef: "egress-paused-v1",
        },
        ...(input.atprotoEnabled
          ? [
              {
                when: "at.xrpc.server.disabled",
                behavior: "at_routes_denied",
                contractRef: "at-disabled-v1",
              },
            ]
          : []),
      ],
    },
    events: {
      catalogVersion: "1.0.0",
      topics: input.profile === "ap-core"
        ? []
        : buildEventTopics(input),
    },
    security: {
      internalApisAuth: "bearer",
      signingKeysLocation: "activitypods-only",
      failClosed: true,
    },
  };
}

/**
 * Build the full events catalog for non-ap-core profiles.
 * Includes Kafka-backed topics, the in-process unified stream, DLQ topics,
 * and the canonical event log when enabled.
 */
function buildEventTopics(input: ProviderCapabilitiesBuildInput): TopicEventEntry[] {
  const topics: TopicEventEntry[] = [
    {
      name: "ap.stream1.local-public.v1",
      schema: "activity-stream-event-v1",
      retentionDays: input.firehoseRetentionDays,
      replay: true,
      dlqTopic: "ap.stream1.local-public.dlq",
      dlqSemantics: "dead-letter",
    },
    {
      name: "ap.stream2.remote-public.v1",
      schema: "activity-stream-event-v1",
      retentionDays: input.firehoseRetentionDays,
      replay: true,
      dlqTopic: "ap.stream2.remote-public.dlq",
      dlqSemantics: "dead-letter",
    },
    {
      name: "ap.firehose.v1",
      schema: "activity-stream-event-v1",
      retentionDays: input.firehoseRetentionDays,
      replay: true,
      dlqTopic: "ap.firehose.dlq",
      dlqSemantics: "retry-dlq",
    },
    // In-process unified fan-out (no Kafka retention; not replayable).
    {
      name: "ap.unified.v1",
      schema: "activity-stream-event-v1",
      retentionDays: 0,
      replay: false,
    },
  ];

  if (input.enableCanonicalEventLog) {
    topics.push({
      name: "ap.canonical.v1",
      schema: "canonical-activity-event-v1",
      retentionDays: input.firehoseRetentionDays,
      replay: true,
      dlqTopic: "ap.canonical.dlq",
      dlqSemantics: "dead-letter",
    });
  }

  if (input.enableMediaPipeline) {
    topics.push({
      name: "media.asset.created.v1",
      schema: "media-asset-created-v1",
      retentionDays: input.firehoseRetentionDays,
      replay: true,
      dlqTopic: "media.asset.created.dlq",
      dlqSemantics: "dead-letter",
    });
  }

  return topics;
}

export function renderCapabilitiesResponse(document: ProviderCapabilitiesDocument): {
  body: string;
  etag: string;
} {
  const body = JSON.stringify(document, null, 2);
  const etag = createHash("sha256").update(body).digest("hex");
  return { body, etag };
}
