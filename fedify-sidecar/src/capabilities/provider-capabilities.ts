import { createHash } from "node:crypto";
import {
  CapabilityEntry,
  ProviderCapabilitiesBuildInput,
  ProviderCapabilitiesDocument,
  ProviderProfile,
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

    if (input.enableOpenSearchIndexer) {
      caps.push(enabledCapability("ap.search.opensearch", ["ap.firehose"], {
        indexRefreshSeconds: 1,
        queryTimeoutMs: 3000,
      }));
    }

    if (input.enableMrf) {
      caps.push(enabledCapability("ap.mrf", [], { policyModules: 16 }));
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
      ],
    },
    events: {
      catalogVersion: "1.0.0",
      topics: input.profile === "ap-core"
        ? []
        : [
            {
              name: "ap.stream1.local-public.v1",
              schema: "activity-stream-event-v1",
              retentionDays: input.firehoseRetentionDays,
              replay: true,
            },
            {
              name: "ap.stream2.remote-public.v1",
              schema: "activity-stream-event-v1",
              retentionDays: input.firehoseRetentionDays,
              replay: true,
            },
            {
              name: "ap.firehose.v1",
              schema: "activity-stream-event-v1",
              retentionDays: input.firehoseRetentionDays,
              replay: true,
            },
          ],
    },
    security: {
      internalApisAuth: "bearer",
      signingKeysLocation: "activitypods-only",
      failClosed: true,
    },
  };
}

export function renderCapabilitiesResponse(document: ProviderCapabilitiesDocument): {
  body: string;
  etag: string;
} {
  const body = JSON.stringify(document, null, 2);
  const etag = createHash("sha256").update(body).digest("hex");
  return { body, etag };
}
